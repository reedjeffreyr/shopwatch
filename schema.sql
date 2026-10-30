-- OverSkill Data Export
-- App: Shopwatch (shopwatch)
-- Team: Jeff's Team
-- Exported at: 2026-10-30 20:36:49 UTC
-- Export Version: 1.2
--
-- This export includes:
-- 1. Complete database schema
-- 2. All application data
-- 3. An audit log that records later changes to your tables
-- 4. Performance indexes
--
-- Runs on any PostgreSQL 14+ database (no extensions needed), and
-- can be run again on the same database. You own your data.


-- Create application schema
CREATE SCHEMA IF NOT EXISTS app_24491;

-- Set search path
SET search_path TO app_24491, public;


-- Table: shop_stores
CREATE TABLE IF NOT EXISTS "shop_stores" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "last_check_status" TEXT,
  "ignored_terms" TEXT,
  "owner_email" TEXT NOT NULL,
  "store_name" TEXT,
  "store_url" TEXT NOT NULL,
  "baseline_signature" TEXT,
  "alert_email" TEXT,
  "baseline_title" TEXT,
  "baseline_screenshot_url" TEXT,
  "weekly_summary" BOOLEAN DEFAULT FALSE,
  "owner_user_id" TEXT,
  "status" TEXT DEFAULT 'checking',
  "last_checked_at" TIMESTAMP WITH TIME ZONE,
  "is_client_managed" BOOLEAN DEFAULT FALSE,
  "created_by_email" TEXT,
  "baseline_load_ms" NUMERIC,
  "baseline_scripts_json" TEXT,
  "baseline_product_page" TEXT,
  "baseline_collection_page" TEXT,
  "team_id" TEXT,
  organization_id TEXT,
  app_id TEXT DEFAULT '24491',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);


-- Table: store_checks
CREATE TABLE IF NOT EXISTS "store_checks" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "owner_user_id" TEXT,
  "checked_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "homepage_status" NUMERIC,
  "collection_status" NUMERIC,
  "product_status" NUMERIC,
  "cart_status" NUMERIC,
  "checkout_status" NUMERIC,
  "add_to_cart_status" TEXT,
  "load_ms" NUMERIC,
  "page_title" TEXT,
  "page_signature" TEXT,
  "store_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "screenshot_url" TEXT,
  "scripts_json" TEXT,
  "summary" TEXT NOT NULL,
  "issues_json" TEXT,
  "team_id" TEXT,
  organization_id TEXT,
  app_id TEXT DEFAULT '24491',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);


-- Table: store_alerts
CREATE TABLE IF NOT EXISTS "store_alerts" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "owner_user_id" TEXT,
  "severity" TEXT NOT NULL,
  "status" TEXT DEFAULT 'open',
  "store_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "screenshot_url" TEXT,
  "team_id" TEXT,
  organization_id TEXT,
  app_id TEXT DEFAULT '24491',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);


-- Table: fix_requests
CREATE TABLE IF NOT EXISTS "fix_requests" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "store_url" TEXT NOT NULL,
  "owner_user_id" TEXT,
  "owner_email" TEXT NOT NULL,
  "issue_summary" TEXT NOT NULL,
  "status" TEXT DEFAULT 'new',
  "store_id" TEXT NOT NULL,
  "admin_notes" TEXT,
  "team_id" TEXT,
  organization_id TEXT,
  app_id TEXT DEFAULT '24491',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);


-- Table: monitor_states
CREATE TABLE IF NOT EXISTS "monitor_states" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "scan_offset" NUMERIC DEFAULT 0,
  "last_scan_at" TIMESTAMP WITH TIME ZONE,
  "team_id" TEXT,
  organization_id TEXT,
  app_id TEXT DEFAULT '24491',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);


-- ========================================

-- (Data intentionally not included in this repo.)
