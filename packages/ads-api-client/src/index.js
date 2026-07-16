import { z } from 'zod';

const AdsMetricsSchema = z.object({ campaignName: z.string(), impressions: z.number(), clicks: z.number(), spend: z.number(), sales: z.number(), orders: z.number() });

export class AdsApiClient {
  /** @returns {Promise<Array<{campaignName:string, impressions:number, clicks:number, spend:number, sales:number, orders:number}>>} */
  async listCampaignMetrics() {
    return z.array(AdsMetricsSchema).parse([]);
  }
}
