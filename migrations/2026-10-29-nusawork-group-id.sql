-- Migration: `asset_holders.nusawork_group_id` — stores Nusawork's note `id_group`
-- directly in SIMAS so that return, update, and delete operations no longer need
-- to query Nusawork's note list or rely on an `id_holder` custom field in Nusawork.
--
-- HOW TO RUN
--   mysql -u <user> -p <database> < migrations/2026-10-29-nusawork-group-id.sql

ALTER TABLE `asset_holders`
  ADD COLUMN `nusawork_group_id` bigint DEFAULT NULL AFTER `return_handover_id`,
  ADD INDEX `idx_asset_holders_nusawork_group_id` (`nusawork_group_id`);
