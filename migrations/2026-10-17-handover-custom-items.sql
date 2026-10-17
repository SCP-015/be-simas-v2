-- Migration: handover custom return items.
-- These are non-master-data items (for example ID cards) that must appear in
-- the signed handover document without changing inventory stock balances.
--
-- Run after backing up the target database:
--   mysql -u <user> -p <database> < migrations/2026-10-17-handover-custom-items.sql

CREATE TABLE `handover_custom_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `handover_id` int NOT NULL,
  `name` varchar(255) NOT NULL,
  `code` varchar(255) DEFAULT NULL,
  `quantity` int NOT NULL,
  `unit` varchar(100) DEFAULT NULL,
  `note` text,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `IDX_handover_custom_items_handover_id` (`handover_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
