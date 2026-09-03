// Order scheduling, as a Fastify plugin.
//
// The standalone tool served these as server-rendered EJS pages behind
// express-session. Everything below is the same set of operations re-exposed
// as JSON under this platform's own auth: the web app is a React SPA holding
// a JWT, so there is nothing for a session cookie or a template engine to do
// here. The business logic is untouched - every route delegates to the same
// services and repositories the Express version called.
//
// Two rules hold on every route in this file:
//
//  1. The tenant comes from the PATH and is checked against the JWT by
//     requireTenantUser before anything else runs. It is never read from a
//     body or a query string.
//  2. Everything that touches a scheduling table runs inside
//     withSchedulingTenant, which binds `app.current_tenant_id` to the
//     connection so migration 025's row-level policies apply. This is a
//     second line of defence, not the only one - the repositories still put
//     sellerId in every WHERE clause.
import { z } from 'zod';
import {
  AppError,
  marketplaceAccountsRepo,
  marketplaceAccountSyncStateRepo,
  marketplacesRepo,
  orderItemsRepo,
  ordersRepo,
  packagesRepo,
  schedulingService,
  shipmentsRepo,
  orderSyncService,
  withSchedulingTenant,
} from '@recon/order-scheduler';
import { ensureAmazonSchedulingAccount } from '../jobs/scheduling-link.js';

const PAGE_SIZE = 50;

// Terminal, "done with it" statuses. A visit to the orders list with no
// explicit status filter hides these, so the default view answers "what still
// needs action" rather than "every order ever synced". SHIPPED is in the list
// because it means Amazon itself reported the order already fulfilled -
// handled outside this tool, and just as done as SCHEDULED or CANCELLED.
const DONE_STATUSES = ['SCHEDULED', 'CANCELLED', 'SHIPPED'];

const OrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  marketplaceAccountId: z.string().uuid().optional(),
  // Present-but-empty means "All statuses" and is meaningfully different from
  // absent, which means "you have not chosen, so show what needs action".
  status: z.string().trim().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().trim().default(''),
});

const PackageSchema = z.object({
  weightGrams: z.coerce.number().positive('Weight must be greater than 0'),
  lengthCm: z.coerce.number().positive('Length must be greater than 0'),
  widthCm: z.coerce.number().positive('Width must be greater than 0'),
  heightCm: z.coerce.number().positive('Height must be greater than 0'),
  packageType: z.string().trim().min(1, 'Package type is required'),
});

const BulkScheduleSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1, 'Select at least one order to schedule.').max(200),
});

const ShipmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  status: z.string().trim().optional(),
  q: z.string().trim().default(''),
});

/**
 * The package's own error classes carry `status` and `expose`; Fastify reads
 * `statusCode`. Without this translation an InvalidStateError ("this order is
 * not ready to schedule") would surface as a 500 with a generic message
 * instead of the 422 and the real reason the UI needs to show.
 *
 * `expose: false` errors (CryptoError, and anything unrecognised) keep their
 * message out of the response on purpose - those messages exist for an
 * operator reading a server log, not for a browser.
 */
function toHttpError(error) {
  if (error instanceof AppError) {
    if (error.expose) return Object.assign(new Error(error.message), { statusCode: error.status });
    return Object.assign(new Error('The scheduling service could not complete this request.'), {
      statusCode: error.status >= 500 ? 500 : error.status,
      cause: error,
    });
  }
  return error;
}

/**
 * Every route body runs through here: bind the tenant scope once, and
 * translate the package's errors on the way out. Without the single wrapper
 * each route would repeat both, and the first one written without them would
 * be a silent zero-rows bug (see db/pool.js on why an unbound query returns
 * nothing rather than failing).
 */
async function inTenantScope(tenantId, fn) {
  try {
    return await withSchedulingTenant(tenantId, fn);
  } catch (error) {
    throw toHttpError(error);
  }
}

export default async function schedulingRoutes(app, { requireTenantUser }) {
  const params = z.object({ tenantId: z.string().uuid() });
  const orderParams = params.extend({ orderId: z.string().uuid() });

  /**
   * What the scheduling section needs to render its shell: whether Amazon is
   * connected at all, the per-status counts for the filter chips, and when
   * each account last synced.
   *
   * This is also where the reconciliation connection is mirrored across (see
   * scheduling-link.js). Doing it on the overview rather than behind a
   * "Connect" button is the point: a seller who re-authorizes Amazon for the
   * Tax Invoicing role has a new refresh token, and the scheduler picks it up
   * the next time this page loads, with nothing to click.
   */
  app.get('/api/tenants/:tenantId/scheduling/overview', async request => {
    const { tenantId } = params.parse(request.params);
    await requireTenantUser(request, tenantId);

    const link = await ensureAmazonSchedulingAccount(tenantId);

    return inTenantScope(tenantId, async () => {
      const [accounts, counts] = await Promise.all([
        marketplaceAccountsRepo.listBySeller(tenantId),
        ordersRepo.countsByInternalStatus(tenantId),
      ]);
      const syncStates = await Promise.all(
        accounts.map(async account => ({
          marketplaceAccountId: account.id,
          ...(await marketplaceAccountSyncStateRepo.get(account.id)),
        })),
      );
      return {
        connected: link.linked,
        connectionReason: link.reason,
        accounts,
        syncStates,
        // Already a { internal_status: count } object - the repository does
        // that fold itself.
        counts,
        doneStatuses: DONE_STATUSES,
      };
    });
  });

  app.get('/api/tenants/:tenantId/scheduling/orders', async request => {
    const { tenantId } = params.parse(request.params);
    await requireTenantUser(request, tenantId);
    const query = OrderListQuerySchema.parse(request.query ?? {});
    const statusProvided = Object.prototype.hasOwnProperty.call(request.query ?? {}, 'status');

    return inTenantScope(tenantId, async () => {
      const { rows, total } = await ordersRepo.list(tenantId, {
        marketplaceAccountId: query.marketplaceAccountId,
        internalStatus: query.status || undefined,
        excludeInternalStatuses: statusProvided ? undefined : DONE_STATUSES,
        from: query.from || undefined,
        to: query.to || undefined,
        search: query.q,
        limit: PAGE_SIZE,
        offset: (query.page - 1) * PAGE_SIZE,
      });
      // One query for every order's primary package rather than one per row -
      // the list shows a "package ready?" indicator on each line.
      const packagesByOrder = await packagesRepo.findPrimaryByOrderIds(tenantId, rows.map(o => o.id));
      return {
        orders: rows.map(order => {
          const pkg = packagesByOrder.get(order.id) ?? null;
          return { ...order, package: pkg, packageComplete: packagesRepo.isComplete(pkg) };
        }),
        total,
        page: query.page,
        pageSize: PAGE_SIZE,
        pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        showingUnscheduledDefault: !statusProvided,
      };
    });
  });

  app.get('/api/tenants/:tenantId/scheduling/orders/:orderId', async (request, reply) => {
    const { tenantId, orderId } = orderParams.parse(request.params);
    await requireTenantUser(request, tenantId);

    return inTenantScope(tenantId, async () => {
      const order = await ordersRepo.findById(tenantId, orderId);
      // 404 rather than 403 for an order this tenant cannot see, so the API
      // cannot be used to probe which order ids exist on other tenants.
      if (!order) return reply.code(404).send({ error: 'Order not found' });

      const [items, packages, shipments] = await Promise.all([
        orderItemsRepo.listByOrder(tenantId, orderId),
        packagesRepo.listByOrder(tenantId, orderId),
        shipmentsRepo.listByOrder(tenantId, orderId),
      ]);
      const pkg = packages[0] ?? (await packagesRepo.getOrCreatePrimary(tenantId, orderId));
      return {
        order,
        items,
        package: pkg,
        extraPackages: packages.filter(p => p.package_number !== 1),
        shipments,
        isComplete: packagesRepo.isComplete(pkg),
        missingFields: packagesRepo.missingFields(pkg),
      };
    });
  });

  /**
   * Save the manually measured package. Amazon needs real weight and
   * dimensions to quote an Easy Ship slot; this is the one thing in the whole
   * flow a person genuinely has to type.
   */
  app.put('/api/tenants/:tenantId/scheduling/orders/:orderId/package', async (request, reply) => {
    const { tenantId, orderId } = orderParams.parse(request.params);
    const user = await requireTenantUser(request, tenantId);
    const parsed = PackageSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid package details' });
    }

    return inTenantScope(tenantId, async () => {
      const order = await ordersRepo.findById(tenantId, orderId);
      if (!order) return reply.code(404).send({ error: 'Order not found' });

      const pkg = await packagesRepo.getOrCreatePrimary(tenantId, orderId);
      const saved = await packagesRepo.save(tenantId, pkg.id, parsed.data, user.sub ?? null);
      // Every required field is present and valid, so this order can move on.
      // A partial save never reaches here - the schema rejected it above.
      let internalStatus = order.internal_status;
      if (['READY_FOR_REVIEW', 'SYNCED', 'NEW'].includes(order.internal_status)) {
        await ordersRepo.updateInternalStatus(tenantId, orderId, 'READY_TO_SCHEDULE');
        internalStatus = 'READY_TO_SCHEDULE';
      }
      return {
        package: saved,
        order: { ...order, internal_status: internalStatus },
        isComplete: packagesRepo.isComplete(saved),
        missingFields: packagesRepo.missingFields(saved),
      };
    });
  });

  app.post('/api/tenants/:tenantId/scheduling/orders/:orderId/schedule', async (request, reply) => {
    const { tenantId, orderId } = orderParams.parse(request.params);
    const user = await requireTenantUser(request, tenantId);

    return inTenantScope(tenantId, async () => {
      const order = await ordersRepo.findById(tenantId, orderId);
      if (!order) return reply.code(404).send({ error: 'Order not found' });

      const [result] = await schedulingService.scheduleOrders(tenantId, [orderId], user.sub ?? null);
      const updated = await ordersRepo.findById(tenantId, orderId);
      const shipments = await shipmentsRepo.listByOrder(tenantId, orderId);
      // A refused schedule is a 200 carrying `ok: false` and the reason, not
      // an error status: the request itself was valid and understood, and the
      // per-order reason ("Weight is missing", "already booked") is exactly
      // what the UI puts on the row.
      return { ok: result.ok, reason: result.reason ?? null, order: updated, shipments };
    });
  });

  /** "Schedule selected" - the bulk-vs-single decision happens in the service. */
  app.post('/api/tenants/:tenantId/scheduling/orders/bulk-schedule', async (request, reply) => {
    const { tenantId } = params.parse(request.params);
    const user = await requireTenantUser(request, tenantId);
    const parsed = BulkScheduleSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid selection' });
    }

    return inTenantScope(tenantId, async () => {
      const results = await schedulingService.scheduleOrders(tenantId, parsed.data.orderIds, user.sub ?? null);
      const succeeded = results.filter(r => r.ok).length;
      return { results, succeeded, attempted: results.length };
    });
  });

  /**
   * Pull orders from Amazon now. The nightly sweep does this unattended (see
   * startScheduler in jobs/sync.js); this is the "I just shipped something,
   * show me" button.
   */
  app.post('/api/tenants/:tenantId/scheduling/sync', async (request, reply) => {
    const { tenantId } = params.parse(request.params);
    await requireTenantUser(request, tenantId);

    const link = await ensureAmazonSchedulingAccount(tenantId);
    if (!link.linked) {
      return reply.code(409).send({
        error: 'Connect Amazon on the Reports page first - order scheduling uses the same connection.',
      });
    }

    return inTenantScope(tenantId, async () => {
      const accounts = await marketplaceAccountsRepo.listAuthorizedBySeller(tenantId);
      const results = [];
      for (const account of accounts) {
        const syncState = await marketplaceAccountSyncStateRepo.get(account.id);
        const since = syncState?.last_synced_at ? new Date(syncState.last_synced_at) : undefined;
        try {
          const outcome = await orderSyncService.syncAccount(tenantId, account, account.marketplace_code, { since });
          results.push({ marketplaceAccountId: account.id, ok: true, ...outcome });
        } catch (error) {
          // One account's failure is reported, not thrown: a tenant with two
          // connected accounts should still get the other one's orders.
          request.log.error({ err: error, marketplaceAccountId: account.id }, 'scheduling sync failed');
          results.push({ marketplaceAccountId: account.id, ok: false, reason: toHttpError(error).message });
        }
      }
      return { results, synced: results.reduce((sum, r) => sum + (r.synced ?? 0), 0) };
    });
  });

  app.get('/api/tenants/:tenantId/scheduling/shipments', async request => {
    const { tenantId } = params.parse(request.params);
    await requireTenantUser(request, tenantId);
    const query = ShipmentListQuerySchema.parse(request.query ?? {});

    return inTenantScope(tenantId, async () => {
      // listBySellers takes an array because the standalone tool had one user
      // spanning many sellers. Here it is always exactly this tenant, and the
      // value comes from the verified path parameter.
      const { rows, total } = await shipmentsRepo.list([tenantId], {
        status: query.status || undefined,
        search: query.q,
        limit: PAGE_SIZE,
        offset: (query.page - 1) * PAGE_SIZE,
      });
      return {
        shipments: rows,
        total,
        page: query.page,
        pageSize: PAGE_SIZE,
        pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      };
    });
  });

  /** The four marketplaces the registry knows about, and what each can do. */
  app.get('/api/tenants/:tenantId/scheduling/marketplaces', async request => {
    const { tenantId } = params.parse(request.params);
    await requireTenantUser(request, tenantId);
    // marketplaces is a global lookup with no seller_id and no policy, so no
    // tenant scope is needed to read it.
    return { marketplaces: await marketplacesRepo.listAll() };
  });
}
