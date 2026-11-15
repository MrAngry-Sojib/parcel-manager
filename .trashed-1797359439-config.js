/* =====================================================================
   config.js — the ONLY file you must edit before deploying.

   Paste the two values from:  Supabase Dashboard -> Project Settings -> API
     * Project URL            (looks like https://abcdxyz.supabase.co)
     * Publishable key        (starts with sb_publishable_...)   — or the older "anon public" key

   These two values are SAFE to publish: access is protected by Row Level Security.
   NEVER paste the "secret" or "service_role" key here.
   ===================================================================== */
window.PM = window.PM || {};

PM.config = {
  SUPABASE_URL: 'PASTE_YOUR_SUPABASE_PROJECT_URL_HERE',
  SUPABASE_KEY: 'PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE',

  STORAGE_BUCKET: 'shop-assets',        // created by supabase/schema.sql
  PAGE_SIZE: 25,                        // orders per page in Order History
  MAX_IMAGE_BYTES: 2 * 1024 * 1024,     // logo / QR upload limit (2 MB, same as the bucket)
  DEFAULT_LABEL_MM: { w: 100, h: 150 }  // 4 x 6 inch thermal label
};
