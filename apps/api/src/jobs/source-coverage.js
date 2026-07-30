const toTime = value => {
  if (value == null || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

/**
 * A source can be synchronized in several adjacent jobs. Coverage is complete
 * when their union spans the requested half-open range without a gap.
 */
export function intervalsCoverRange(rows, range) {
  const requestedStart = toTime(range.start);
  const requestedEnd = toTime(range.end);
  if (requestedStart == null || requestedEnd == null || requestedStart >= requestedEnd) return false;

  const intervals = rows
    .map(row => ({
      start: Math.max(requestedStart, toTime(row.data_start_time) ?? Number.POSITIVE_INFINITY),
      end: Math.min(requestedEnd, toTime(row.data_end_time) ?? Number.NEGATIVE_INFINITY)
    }))
    .filter(interval => interval.start < interval.end)
    .sort((left, right) => left.start - right.start || right.end - left.end);

  let coveredUntil = requestedStart;
  for (const interval of intervals) {
    if (interval.start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, interval.end);
    if (coveredUntil >= requestedEnd) return true;
  }
  return false;
}

const isCompletedReport = (row, reportType) => (
  row.report_type === reportType
  && row.status === 'completed'
  && row.coverage_complete === true
);

export async function loadSourceCoverage(db, tenantId, range) {
  const jobs = (await db.query(
    `select report_type,status,data_start_time,data_end_time,coverage_complete,
       orders_coverage_complete,finance_coverage_complete,inventory_coverage_complete
     from sync_jobs
     where tenant_id=$1
       and completed_at is not null
       and data_start_time < $3::timestamptz
       and data_end_time > $2::timestamptz`,
    [tenantId, range.start, range.end]
  )).rows;

  const covers = predicate => intervalsCoverRange(jobs.filter(predicate), range);
  return {
    ordersComplete: covers(row => (
      row.report_type === 'DIRECT_SP_API_SYNC' && row.orders_coverage_complete === true
    )),
    financeComplete: covers(row => (
      row.report_type === 'DIRECT_SP_API_SYNC' && row.finance_coverage_complete === true
    )),
    inventoryComplete: covers(row => (
      row.report_type === 'DIRECT_SP_API_SYNC' && row.inventory_coverage_complete === true
    )),
    returnsComplete: covers(row => isCompletedReport(row, 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA')),
    settlementsComplete: covers(row => isCompletedReport(row, 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2')),
    reimbursementsComplete: covers(row => isCompletedReport(row, 'GET_FBA_REIMBURSEMENTS_DATA')),
    gstB2bComplete: covers(row => isCompletedReport(row, 'GET_GST_MTR_B2B_CUSTOM')),
    gstB2cComplete: covers(row => isCompletedReport(row, 'GET_GST_MTR_B2C_CUSTOM')),
    salesTrafficComplete: covers(row => isCompletedReport(row, 'GET_SALES_AND_TRAFFIC_REPORT'))
  };
}
