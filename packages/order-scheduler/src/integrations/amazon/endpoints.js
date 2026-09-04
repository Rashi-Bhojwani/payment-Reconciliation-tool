// Marketplace → region → SP-API host. India is what this application
// actually targets today; the others are recorded because the SP-API
// itself is not India-only and a seller row already carries a `region`.
export const MARKETPLACES = {
  A21TJRUUN4KGV: { name: 'Amazon.in', region: 'eu-west-1', countryCode: 'IN' },
  ATVPDKIKX0DER: { name: 'Amazon.com', region: 'us-east-1', countryCode: 'US' },
  A1F83G8C2ARO7P: { name: 'Amazon.co.uk', region: 'eu-west-1', countryCode: 'GB' },
  A1PA6795UKMFR9: { name: 'Amazon.de', region: 'eu-west-1', countryCode: 'DE' },
  A2VIGQ35RCS4UG: { name: 'Amazon.ae', region: 'eu-west-1', countryCode: 'AE' },
};

const REGION_HOSTS = {
  'eu-west-1': 'sellingpartnerapi-eu.amazon.com',
  'us-east-1': 'sellingpartnerapi-na.amazon.com',
  'us-west-2': 'sellingpartnerapi-fe.amazon.com',
};

const SANDBOX_REGION_HOSTS = {
  'eu-west-1': 'sandbox.sellingpartnerapi-eu.amazon.com',
  'us-east-1': 'sandbox.sellingpartnerapi-na.amazon.com',
  'us-west-2': 'sandbox.sellingpartnerapi-fe.amazon.com',
};

export function hostForRegion(region, { sandbox = false } = {}) {
  const table = sandbox ? SANDBOX_REGION_HOSTS : REGION_HOSTS;
  const host = table[region];
  if (!host) throw new Error(`No SP-API host known for region "${region}"`);
  return host;
}

export function marketplaceInfo(amazonMarketplaceId) {
  return MARKETPLACES[amazonMarketplaceId] ?? null;
}
