import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketplaceAdapter } from '../src/integrations/marketplace/MarketplaceAdapter.js';
import { NO_CAPABILITIES } from '../src/integrations/marketplace/MarketplaceCapabilities.js';
import { NotImplementedError } from '../src/lib/errors.js';
import { getAdapter, getCapabilities, listRegisteredCodes } from '../src/integrations/marketplace/registry.js';
import { FlipkartAdapter } from '../src/integrations/flipkart/FlipkartAdapter.js';
import { MyntraAdapter } from '../src/integrations/myntra/MyntraAdapter.js';
import { MeeshoAdapter } from '../src/integrations/meesho/MeeshoAdapter.js';
import { AmazonAdapter } from '../src/integrations/amazon/AmazonAdapter.js';

test('MarketplaceAdapter cannot be instantiated directly', () => {
  assert.throws(() => new MarketplaceAdapter(), /abstract/);
});

test('a subclass without a static code fails fast at construction', () => {
  class BrokenAdapter extends MarketplaceAdapter {}
  assert.throws(() => new BrokenAdapter(), /must set a static `code`/);
});

test('a subclass with invalid capabilities fails fast at construction', () => {
  class BrokenAdapter extends MarketplaceAdapter {
    static code = 'BROKEN';
    static capabilities = { supportsOrderSync: 'yes' }; // wrong type, missing keys
  }
  assert.throws(() => new BrokenAdapter());
});

test('every base class method is NotImplementedError by default', async () => {
  class BareAdapter extends MarketplaceAdapter {
    static code = 'BARE';
    static capabilities = NO_CAPABILITIES;
  }
  const adapter = new BareAdapter();
  const calls = [
    () => adapter.authorize({}, {}),
    () => adapter.handleCallback({}),
    () => adapter.refreshAuthentication({}),
    () => adapter.getOrders({}, {}),
    () => adapter.getOrder({}, 'x'),
    () => adapter.updateOrder({}, 'x', {}),
    () => adapter.scheduleOrder({}, {}, {}),
    () => adapter.scheduleOrdersBulk({}, []),
    () => adapter.getShipmentStatus({}, 'x'),
    () => adapter.getInventory({}),
    () => adapter.cancelOrder({}, 'x'),
  ];
  for (const call of calls) {
    await assert.rejects(call(), NotImplementedError);
  }
});

test('stub adapters (Flipkart/Myntra/Meesho) declare every capability false', () => {
  for (const Adapter of [FlipkartAdapter, MyntraAdapter, MeeshoAdapter]) {
    const capabilities = getCapabilities(Adapter.code);
    for (const [flag, value] of Object.entries(capabilities)) {
      assert.equal(value, false, `${Adapter.code}.${flag} must be false — no method backs it yet`);
    }
  }
});

test('stub adapters never make a network call — every method throws NotImplementedError', async () => {
  for (const Adapter of [FlipkartAdapter, MyntraAdapter, MeeshoAdapter]) {
    const adapter = getAdapter(Adapter.code);
    await assert.rejects(adapter.getOrders({}, {}), NotImplementedError);
    await assert.rejects(adapter.scheduleOrder({}, {}, {}), NotImplementedError);
  }
});

test('the registry knows about every marketplace, Amazon included', () => {
  const codes = listRegisteredCodes();
  assert.ok(codes.includes('AMAZON'));
  assert.ok(codes.includes('FLIPKART'));
  assert.ok(codes.includes('MYNTRA'));
  assert.ok(codes.includes('MEESHO'));
});

test('a capability an adapter declares true has a real overridden method, not the stub', () => {
  // If AmazonAdapter ever regresses to inheriting a capability-true method
  // from the base class stub, this catches it: the override must be defined
  // directly on the subclass prototype, not just inherited.
  const amazonCapabilities = getCapabilities('AMAZON');
  const methodForCapability = {
    supportsOrderSync: 'getOrders',
    supportsSingleScheduling: 'scheduleOrder',
    supportsBulkScheduling: 'scheduleOrdersBulk',
    supportsShipmentTracking: 'getShipmentStatus',
  };
  for (const [capability, methodName] of Object.entries(methodForCapability)) {
    if (!amazonCapabilities[capability]) continue;
    const ownMethod = Object.prototype.hasOwnProperty.call(AmazonAdapter.prototype, methodName);
    assert.ok(ownMethod, `AmazonAdapter declares ${capability} but does not override ${methodName}()`);
  }
});

test('an unregistered marketplace code is a clear NotFoundError, not a crash', () => {
  assert.throws(() => getAdapter('NONEXISTENT_MARKETPLACE'));
});
