-- ia-buho MySQL schema
-- Import this file in your hosting database manager.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS bhdtlai_buhoia
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE bhdtlai_buhoia;

-- WhatsApp users known by the bot
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone VARCHAR(32) NOT NULL,
  display_name VARCHAR(120) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  processed_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  failed_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  avg_latency_ms DECIMAL(10,2) NOT NULL DEFAULT 0,
  notes TEXT NULL,                                                                                                                            
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_phone (phone),
  KEY idx_users_last_seen (last_seen_at),
  KEY idx_users_active (is_active)
) ENGINE=InnoDB;

-- Per-user runtime configuration
CREATE TABLE IF NOT EXISTS user_runtime_config (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,

  -- Rate Limiting (per user)
  rate_max_messages INT UNSIGNED NOT NULL DEFAULT 15,
  rate_window_ms INT UNSIGNED NOT NULL DEFAULT 60000,
  rate_cooldown_ms INT UNSIGNED NOT NULL DEFAULT 10000,

  -- Gemini generation and protection (per user)
  gemini_temperature DECIMAL(3,2) NOT NULL DEFAULT 0.70,
  gemini_max_output_tokens INT UNSIGNED NOT NULL DEFAULT 1024,
  gemini_timeout_ms INT UNSIGNED NOT NULL DEFAULT 30000,
  gemini_failure_threshold INT UNSIGNED NOT NULL DEFAULT 3,
  gemini_recovery_time_ms INT UNSIGNED NOT NULL DEFAULT 120000,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uk_user_runtime_config_user (user_id),
  CONSTRAINT fk_user_runtime_config_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Global conversation config (only one active row)
CREATE TABLE IF NOT EXISTS global_conversation_config (
  id TINYINT UNSIGNED NOT NULL,
  max_history_messages INT UNSIGNED NOT NULL DEFAULT 20,
  inactivity_timeout_ms INT UNSIGNED NOT NULL DEFAULT 7200000,
  updated_by VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

INSERT INTO global_conversation_config (
  id,
  max_history_messages,
  inactivity_timeout_ms,
  updated_by
)
VALUES (1, 20, 7200000, 'bootstrap')
ON DUPLICATE KEY UPDATE
  max_history_messages = VALUES(max_history_messages),
  inactivity_timeout_ms = VALUES(inactivity_timeout_ms),
  updated_by = VALUES(updated_by);

-- Conversation sessions per user
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  session_key VARCHAR(80) NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total_messages INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('active', 'closed', 'expired') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  UNIQUE KEY uk_sessions_user_key (user_id, session_key),
  KEY idx_sessions_last_activity (last_activity_at),
  KEY idx_sessions_status (status),
  CONSTRAINT fk_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Individual conversation messages
CREATE TABLE IF NOT EXISTS conversation_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  direction ENUM('inbound', 'outbound') NOT NULL,
  source ENUM('user', 'bot', 'system') NOT NULL,
  message_id VARCHAR(120) NULL,
  message_type VARCHAR(40) NOT NULL DEFAULT 'text',
  body MEDIUMTEXT NOT NULL,
  latency_ms INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_session_created (session_id, created_at),
  KEY idx_messages_direction (direction),
  CONSTRAINT fk_messages_session
    FOREIGN KEY (session_id) REFERENCES conversation_sessions(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Runtime health snapshots for the dashboard
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  status VARCHAR(24) NOT NULL DEFAULT 'online',
  uptime_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,

  messages_received BIGINT UNSIGNED NOT NULL DEFAULT 0,
  messages_processed BIGINT UNSIGNED NOT NULL DEFAULT 0,
  messages_failed BIGINT UNSIGNED NOT NULL DEFAULT 0,

  gemini_calls BIGINT UNSIGNED NOT NULL DEFAULT 0,
  gemini_errors BIGINT UNSIGNED NOT NULL DEFAULT 0,
  gemini_key_rotations BIGINT UNSIGNED NOT NULL DEFAULT 0,

  whatsapp_messages_sent BIGINT UNSIGNED NOT NULL DEFAULT 0,
  whatsapp_errors BIGINT UNSIGNED NOT NULL DEFAULT 0,

  rate_limit_hits BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duplicate_messages BIGINT UNSIGNED NOT NULL DEFAULT 0,
  security_blocked BIGINT UNSIGNED NOT NULL DEFAULT 0,

  latency_avg_ms INT UNSIGNED NOT NULL DEFAULT 0,
  latency_p50_ms INT UNSIGNED NOT NULL DEFAULT 0,
  latency_p95_ms INT UNSIGNED NOT NULL DEFAULT 0,
  latency_p99_ms INT UNSIGNED NOT NULL DEFAULT 0,

  throughput_messages_per_minute INT UNSIGNED NOT NULL DEFAULT 0,
  queue_total_pending INT UNSIGNED NOT NULL DEFAULT 0,
  active_conversations INT UNSIGNED NOT NULL DEFAULT 0,

  heap_used_mb DECIMAL(10,2) NOT NULL DEFAULT 0,
  heap_total_mb DECIMAL(10,2) NOT NULL DEFAULT 0,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_metrics_snapshots_created (created_at)
) ENGINE=InnoDB;

-- Detailed Gemini key runtime status
CREATE TABLE IF NOT EXISTS gemini_key_status (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_slot INT UNSIGNED NOT NULL,
  key_label VARCHAR(80) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failures INT UNSIGNED NOT NULL DEFAULT 0,
  total_calls BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_errors BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error_message TEXT NULL,
  last_error_at DATETIME NULL,
  disabled_until DATETIME NULL,
  last_used_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_gemini_key_slot (key_slot),
  KEY idx_gemini_key_active (is_active),
  KEY idx_gemini_key_last_error (last_error_at)
) ENGINE=InnoDB;

-- Token usage per Gemini API call
CREATE TABLE IF NOT EXISTS gemini_token_usage (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_slot INT UNSIGNED NOT NULL,
  user_phone VARCHAR(32) NULL,
  input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  total_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  latency_ms INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_token_usage_created (created_at),
  KEY idx_token_usage_key (key_slot),
  KEY idx_token_usage_phone (user_phone)
) ENGINE=InnoDB;

-- Generic runtime events / errors for troubleshooting
CREATE TABLE IF NOT EXISTS system_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  level ENUM('debug', 'info', 'warn', 'error', 'critical') NOT NULL,
  component VARCHAR(80) NOT NULL,
  event_code VARCHAR(80) NULL,
  user_phone VARCHAR(32) NULL,
  message TEXT NOT NULL,
  context_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_system_events_created (created_at),
  KEY idx_system_events_level (level),
  KEY idx_system_events_component (component),
  KEY idx_system_events_user_phone (user_phone)
) ENGINE=InnoDB;

-- =============================================
-- REPORTS MODULE: Automatic conversation insights
-- =============================================

-- Per-message classification (auto-inserted after each AI response)
CREATE TABLE IF NOT EXISTS conversation_insights (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NULL,
  user_phone VARCHAR(32) NOT NULL,
  user_name VARCHAR(120) NULL,
  intent ENUM('greeting','question','purchase_interest','complaint','support','farewell','info_request','price_inquiry','other') NOT NULL DEFAULT 'other',
  commercial_stage VARCHAR(40) NULL,
  product_consulted VARCHAR(120) NULL,
  outcome ENUM('purchased','just_asked','problem_reported','unresolved','redirected','ongoing','resolved') NOT NULL DEFAULT 'ongoing',
  sentiment ENUM('positive','neutral','negative') NOT NULL DEFAULT 'neutral',
  topic_summary VARCHAR(255) NULL,
  user_message_preview VARCHAR(255) NULL,
  confidence DECIMAL(3,2) NOT NULL DEFAULT 0.50,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_insights_phone (user_phone),
  KEY idx_insights_intent (intent),
  KEY idx_insights_stage (commercial_stage),
  KEY idx_insights_product (product_consulted),
  KEY idx_insights_outcome (outcome),
  KEY idx_insights_sentiment (sentiment),
  KEY idx_insights_created (created_at)
) ENGINE=InnoDB;

-- Aggregated conversation-level reports
CREATE TABLE IF NOT EXISTS conversation_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NULL,
  user_phone VARCHAR(32) NOT NULL,
  user_name VARCHAR(120) NULL,
  primary_intent VARCHAR(40) NULL,
  final_stage VARCHAR(40) NULL,
  products_consulted JSON NULL,
  final_outcome VARCHAR(40) NULL,
  overall_sentiment VARCHAR(20) NULL,
  topics JSON NULL,
  message_count INT UNSIGNED NOT NULL DEFAULT 0,
  duration_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  resolved TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reports_phone (user_phone),
  KEY idx_reports_session (session_id),
  KEY idx_reports_intent (primary_intent),
  KEY idx_reports_outcome (final_outcome),
  KEY idx_reports_sentiment (overall_sentiment),
  KEY idx_reports_created (created_at)
) ENGINE=InnoDB;
