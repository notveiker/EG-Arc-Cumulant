import cron from 'node-cron';
import { getAllBundles, createNAVSnapshot, getActiveAlertsByBundle, triggerAlert } from '../db/queries.js';
import { getLiveNAV, checkAndUpdateResolutions, getVaultPrice, warmVaultPriceCache } from './pricing.js';
import { getPolymarketBasketNAVs } from './polymarket.js';
import { metrics } from './metrics.js';
import { supabaseEnabled } from '../db/supabase.js';

/**
 * Refresh probabilities for all active bundles.
 * Fetches live Polymarket data, updates DB, and checks for resolutions.
 *
 * Persistence-aware: when Supabase is not configured (`supabaseEnabled` is
 * false) the bundle universe lives only in the database, so there is nothing to
 * refresh. We no-op early instead of churning through empty query results.
 */
async function refreshAllBundles(): Promise<void> {
  // No database → no bundles to refresh. Stay a safe no-op.
  if (!supabaseEnabled) {
    return;
  }

  const startTime = Date.now();
  let cronOk = true;
  let cronError: string | undefined;
  let activeBundlesCount = 0;
  let totalLegsUpdated = 0;
  let totalNewlyResolved = 0;

  try {
    const [bundles, polyNAVs] = await Promise.all([
      getAllBundles(),
      getPolymarketBasketNAVs(),
    ]);
    const activeBundles = bundles.filter((b) => b.status === 'active');
    activeBundlesCount = activeBundles.length;

    for (const bundle of activeBundles) {
      try {
        // Vault price is the authoritative mint price — consistent with UI.
        const vaultPrice = await getVaultPrice(bundle.id);
        // Live Polymarket NAV — the weighted probability shown as 51.9% etc.
        const polyData = polyNAVs.get(bundle.name);

        // Still fetch live Polymarket probabilities so leg data stays fresh
        // for resolution detection and per-leg breakdown.
        const navResult = await getLiveNAV(bundle.id);
        if (navResult) {
          totalLegsUpdated += navResult.legs.filter((l) => l.status === 'active').length;

          // Record the real leg-weighted NAV so history charts match every
          // other NAV surface (was persisting the flat vault par price 1.0).
          const snapshotNav = navResult.nav;
          await createNAVSnapshot(bundle.id, snapshotNav, navResult.legs);
          void vaultPrice;
          if (polyData) {
            console.log(`[cron] ${bundle.name}: nav=${(snapshotNav * 100).toFixed(1)}% polymarket=${(polyData.nav * 100).toFixed(1)}% (${polyData.leg_count} legs)`);
          }
        }

        // Check for newly resolved legs
        const resolved = await checkAndUpdateResolutions(bundle.id);
        totalNewlyResolved += resolved.length;

        // Check price alerts for this bundle
        if (navResult) {
          try {
            const alerts = await getActiveAlertsByBundle(bundle.id);
            const navChangePercent = bundle.issue_price > 0
              ? ((navResult.nav - bundle.issue_price) / bundle.issue_price) * 100
              : 0;

            for (const alert of alerts) {
              let shouldTrigger = false;
              if (alert.alert_type === 'above' && navResult.nav >= alert.threshold) shouldTrigger = true;
              if (alert.alert_type === 'below' && navResult.nav <= alert.threshold) shouldTrigger = true;
              if (alert.alert_type === 'change_percent' && Math.abs(navChangePercent) >= alert.threshold) shouldTrigger = true;

              if (shouldTrigger) {
                await triggerAlert(alert.id, navResult.nav);
              }
            }
          } catch (alertErr) {
            // Alert checking is non-critical, don't fail the cron
          }
        }
      } catch (err) {
        console.error(`Cron: failed to refresh bundle ${bundle.id} (${bundle.name}):`, err);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[cron] Refreshed ${activeBundlesCount} bundles, ${totalLegsUpdated} legs updated, ${totalNewlyResolved} newly resolved (${elapsed}ms)`
    );
  } catch (err) {
    cronOk = false;
    cronError = err instanceof Error ? err.message : String(err);
    console.error('[cron] refreshAllBundles failed:', err);
  } finally {
    metrics.recordCron({
      timestamp: Date.now(),
      duration_ms: Date.now() - startTime,
      bundles_refreshed: activeBundlesCount,
      legs_updated: totalLegsUpdated,
      newly_resolved: totalNewlyResolved,
      ok: cronOk,
      error: cronError,
    });
  }
}

/**
 * Start all cron jobs. Call once after server starts.
 *
 * When Supabase is not configured there is no bundle/NAV history to maintain,
 * so the scheduled refresh would be a no-op every tick — we skip scheduling it
 * entirely. The backend still boots and serves on-chain + Polymarket data.
 */
export function startCronJobs(): void {
  // Warm vault-price cache on startup so first requests get instant prices.
  // This reads on-chain (Arc) + Polymarket data, so it runs regardless of the
  // Supabase configuration (warm pass simply finds no bundles when the DB is off).
  warmVaultPriceCache().then((prices) => {
    console.log(`[cron] Vault price cache warmed — ${prices.size} vaults loaded`);
  }).catch(() => {});

  if (!supabaseEnabled) {
    console.log('[cron] Supabase not configured — skipping scheduled NAV refresh (on-chain + Polymarket data still served).');
    return;
  }

  // Every 2 minutes: refresh all active bundle probabilities
  cron.schedule('*/2 * * * *', async () => {
    console.log('[cron] Starting bundle refresh...');
    await refreshAllBundles();
  });

  console.log('[cron] Price refresh cron scheduled (every 2 minutes)');
}
