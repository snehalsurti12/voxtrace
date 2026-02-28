/**
 * orgDiscoveryRunner.mjs — Orchestrates Salesforce org discovery via REST API.
 *
 * Runs SOQL queries (sourced from sfOrgDiscovery.ts) through the REST client,
 * groups results into categories for the UI, and caches to disk.
 */

import fs from "node:fs";
import path from "node:path";
import { createSfClient, discoverLightningApps } from "./sfRestClient.mjs";

const PROJECT_ROOT = process.cwd();
const PROFILES_PATH = path.resolve(PROJECT_ROOT, "instances", "profiles.json");

// ── SOQL Queries (from sfOrgDiscovery.ts) ──────────────────────────────────

const SOQL = {
  presenceStatuses: `
    SELECT Id, MasterLabel, DeveloperName
    FROM ServicePresenceStatus
    ORDER BY MasterLabel ASC`,

  queues: `
    SELECT Id, Name, DeveloperName
    FROM Group
    WHERE Type = 'Queue'
    ORDER BY Name ASC`,

  skills: `
    SELECT Id, MasterLabel, DeveloperName
    FROM Skill
    ORDER BY MasterLabel ASC`,

  serviceChannels: `
    SELECT Id, MasterLabel, DeveloperName, RelatedEntity
    FROM ServiceChannel
    ORDER BY MasterLabel ASC`,

  routingConfigs: `
    SELECT Id, MasterLabel, DeveloperName, RoutingModel,
           RoutingPriority, CapacityWeight, CapacityType
    FROM RoutingConfiguration
    ORDER BY MasterLabel ASC`,

  businessHours: `
    SELECT Id, Name, IsDefault, IsActive, TimeZoneSidKey,
           MondayStartTime, MondayEndTime,
           TuesdayStartTime, TuesdayEndTime,
           WednesdayStartTime, WednesdayEndTime,
           ThursdayStartTime, ThursdayEndTime,
           FridayStartTime, FridayEndTime,
           SaturdayStartTime, SaturdayEndTime,
           SundayStartTime, SundayEndTime
    FROM BusinessHours
    WHERE IsActive = true
    ORDER BY Name ASC`,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function loadProfile(profileId) {
  if (!fs.existsSync(PROFILES_PATH)) {
    throw new Error(`Missing profiles config: ${PROFILES_PATH}`);
  }
  const config = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  const profile = (config.profiles || []).find((p) => p.id === profileId);
  if (!profile) {
    throw new Error(
      `Profile "${profileId}" not found. Available: ${(config.profiles || []).map((p) => p.id).join(", ")}`
    );
  }
  return profile;
}

function parseEnvFile(filePath) {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  if (!fs.existsSync(resolved)) return {};
  const content = fs.readFileSync(resolved, "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

function resolveStorageStatePath(profile) {
  // Check profile env file for SF_STORAGE_STATE, fall back to convention
  const env = parseEnvFile(profile.envFile || `instances/${profile.id}.env`);
  const explicit = env.SF_STORAGE_STATE;
  if (explicit && fs.existsSync(path.resolve(PROJECT_ROOT, explicit))) {
    return path.resolve(PROJECT_ROOT, explicit);
  }
  // Convention: .auth/sf-{profileId}.json
  const conventional = path.resolve(
    PROJECT_ROOT,
    `.auth/sf-${profile.id}.json`
  );
  if (fs.existsSync(conventional)) {
    return conventional;
  }
  throw new Error(
    `No Salesforce storage state found for profile "${profile.id}". ` +
      `Expected: ${conventional} or SF_STORAGE_STATE in ${profile.envFile}`
  );
}

// ── Discovery Runner ───────────────────────────────────────────────────────

/**
 * Run full org discovery for a profile.
 *
 * @param {string} profileId
 * @returns {Promise<DiscoveryResult>}
 *
 * @typedef {Object} DiscoveryResult
 * @property {string} profileId
 * @property {string} orgId
 * @property {string} instanceUrl
 * @property {string} discoveredAt
 * @property {Object.<string, DiscoveryCategory>} categories
 *
 * @typedef {Object} DiscoveryCategory
 * @property {string} label
 * @property {DiscoveryItem[]} items
 * @property {string|null} error
 *
 * @typedef {Object} DiscoveryItem
 * @property {string} value — Display label
 * @property {string} id — Salesforce ID or developer name
 * @property {string} description — Extra context for UI
 */
export async function runOrgDiscovery(profileId) {
  const profile = loadProfile(profileId);
  const storagePath = resolveStorageStatePath(profile);
  const sf = createSfClient(storagePath);

  const categories = {};

  // Run all queries in parallel, capturing errors per category
  const queries = [
    {
      key: "lightningApps",
      label: "Lightning Apps",
      run: () => discoverLightningApps(sf),
      transform: (records) =>
        records.map((r) => ({
          value: r.label,
          id: r.developerName,
          description: `${r.navType || "Standard"} — ${r.description || "No description"}`,
        })),
    },
    {
      key: "presenceStatuses",
      label: "Presence Statuses",
      run: () => sf.query(SOQL.presenceStatuses),
      transform: (result) =>
        result.records.map((r) => ({
          value: r.MasterLabel,
          id: r.DeveloperName,
          description: `ID: ${r.Id}`,
        })),
    },
    {
      key: "queues",
      label: "Queues",
      run: () => sf.query(SOQL.queues),
      transform: (result) =>
        result.records.map((r) => ({
          value: r.Name,
          id: r.DeveloperName,
          description: `ID: ${r.Id}`,
        })),
    },
    {
      key: "skills",
      label: "Skills",
      run: () => sf.query(SOQL.skills),
      transform: (result) =>
        result.records.map((r) => ({
          value: r.MasterLabel,
          id: r.DeveloperName,
          description: `ID: ${r.Id}`,
        })),
    },
    {
      key: "serviceChannels",
      label: "Service Channels",
      run: () => sf.query(SOQL.serviceChannels),
      transform: (result) =>
        result.records.map((r) => ({
          value: r.MasterLabel,
          id: r.DeveloperName,
          description: `Entity: ${r.RelatedEntity || "—"}`,
        })),
    },
    {
      key: "routingConfigs",
      label: "Routing Configurations",
      run: () => sf.query(SOQL.routingConfigs),
      transform: (result) =>
        result.records.map((r) => ({
          value: r.MasterLabel,
          id: r.DeveloperName,
          description: `Model: ${r.RoutingModel || "—"} | Priority: ${r.RoutingPriority ?? "—"}`,
        })),
    },
    {
      key: "businessHours",
      label: "Business Hours",
      run: () => sf.query(SOQL.businessHours),
      transform: (result) =>
        result.records.map((r) => ({
          value: r.Name,
          id: r.Id,
          description: `TZ: ${r.TimeZoneSidKey || "—"} | Default: ${r.IsDefault ? "Yes" : "No"}`,
        })),
    },
  ];

  const results = await Promise.allSettled(
    queries.map(async (q) => {
      const raw = await q.run();
      return { key: q.key, label: q.label, items: q.transform(raw) };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { key, label, items } = result.value;
      categories[key] = { label, items, error: null };
    } else {
      // Find the query key from the index
      const idx = results.indexOf(result);
      const q = queries[idx];
      categories[q.key] = {
        label: q.label,
        items: [],
        error: result.reason?.message || String(result.reason),
      };
    }
  }

  // Add Connect metadata from env file
  const env = parseEnvFile(profile.envFile || `instances/${profile.id}.env`);
  categories.connect = {
    label: "Connect / Telephony",
    items: [
      {
        value: env.CONNECT_ENTRYPOINT_NUMBER || "",
        id: "entryNumber",
        description: "Entry phone number for inbound calls",
      },
      {
        value: env.CONNECT_INSTANCE_ALIAS || "",
        id: "instanceAlias",
        description: "Amazon Connect instance alias",
      },
    ],
    error: null,
  };

  const discoveryResult = {
    profileId,
    orgId: sf.orgId,
    instanceUrl: sf.instanceUrl,
    discoveredAt: new Date().toISOString(),
    categories,
  };

  // Cache to disk
  const cacheDir = path.resolve(PROJECT_ROOT, ".cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const cachePath = path.resolve(
    cacheDir,
    `org-vocabulary-${profileId}.json`
  );
  fs.writeFileSync(cachePath, JSON.stringify(discoveryResult, null, 2));
  console.log(`[discovery] Cached to ${cachePath}`);

  return discoveryResult;
}

// ── CLI entry point ────────────────────────────────────────────────────────

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("orgDiscoveryRunner.mjs");

if (isMain) {
  const profileId = process.argv[2] || "personal";
  console.log(`[discovery] Running org discovery for profile: ${profileId}`);
  runOrgDiscovery(profileId)
    .then((result) => {
      console.log(`[discovery] Done. Found categories:`);
      for (const [key, cat] of Object.entries(result.categories)) {
        const status = cat.error ? `ERROR: ${cat.error}` : `${cat.items.length} items`;
        console.log(`  ${cat.label}: ${status}`);
      }
    })
    .catch((err) => {
      console.error(`[discovery] Failed: ${err.message}`);
      process.exit(1);
    });
}
