/**
 * sfRestClient.mjs — Salesforce REST API client using stored Playwright session cookies.
 *
 * Extracts the `sid` cookie from a Playwright storage-state JSON file and uses it
 * as a Bearer token for Salesforce REST API calls. No OAuth flow or CLI dependency needed.
 */

import fs from "node:fs";
import path from "node:path";

const SF_API_VERSION = "v59.0";

/**
 * Extract Salesforce session credentials from a Playwright storage-state file.
 *
 * @param {string} storageStatePath — Path to `.auth/sf-{profile}.json`
 * @returns {{ sid: string, instanceUrl: string, orgId: string }}
 */
export function extractSessionFromStorageState(storageStatePath) {
  const absPath = path.resolve(storageStatePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Storage state file not found: ${absPath}`);
  }

  const state = JSON.parse(fs.readFileSync(absPath, "utf8"));
  const cookies = state.cookies || [];

  // Find the sid cookie on a *.my.salesforce.com domain
  const sidCookie = cookies.find(
    (c) => c.name === "sid" && c.domain.includes(".my.salesforce.com")
  );
  if (!sidCookie) {
    throw new Error(
      `No sid cookie found on *.my.salesforce.com in ${absPath}. ` +
        `Session may be expired — re-run auth:state to refresh.`
    );
  }

  // Find the oid cookie on the same domain for org ID
  const oidCookie = cookies.find(
    (c) => c.name === "oid" && c.domain.includes(".my.salesforce.com")
  );

  const instanceUrl = `https://${sidCookie.domain}`;
  const orgId = oidCookie?.value || "";

  return { sid: sidCookie.value, instanceUrl, orgId };
}

/**
 * Create a Salesforce query client from a Playwright storage-state file.
 *
 * Implements the `SalesforceQueryClient` interface from sfOrgDiscovery.ts:
 *   { query<T>(soql: string): Promise<{ records: T[] }> }
 *
 * @param {string} storageStatePath
 * @returns {{ query: (soql: string) => Promise<{ records: any[] }>, instanceUrl: string, orgId: string }}
 */
export function createSfClient(storageStatePath) {
  const { sid, instanceUrl, orgId } =
    extractSessionFromStorageState(storageStatePath);

  async function query(soql) {
    const url = `${instanceUrl}/services/data/${SF_API_VERSION}/query/?q=${encodeURIComponent(soql)}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${sid}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new Error(
          `Salesforce session expired (401). Re-run auth:state to refresh.\n${body}`
        );
      }
      throw new Error(
        `Salesforce REST API error ${resp.status}: ${resp.statusText}\n${body}`
      );
    }

    const data = await resp.json();
    return { records: data.records || [] };
  }

  return { query, instanceUrl, orgId };
}

/**
 * Discover all installed Lightning apps via AppDefinition SOQL.
 * This query is NOT in sfOrgDiscovery.ts — it's the critical missing piece
 * for resolving agent console vs supervisor app confusion.
 *
 * @param {{ query: Function }} sf — Salesforce query client
 * @returns {Promise<Array<{ label: string, developerName: string, description: string, navType: string, durableId: string }>>}
 */
export async function discoverLightningApps(sf) {
  const soql = `SELECT DurableId, Label, DeveloperName, Description, NavType
    FROM AppDefinition
    ORDER BY Label`;

  const { records } = await sf.query(soql);

  return records.map((r) => ({
    label: r.Label || "",
    developerName: r.DeveloperName || "",
    description: r.Description || "",
    navType: r.NavType || "",
    durableId: r.DurableId || "",
  }));
}
