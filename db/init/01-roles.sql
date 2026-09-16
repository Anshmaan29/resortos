-- Two roles (spec §48):
--   resortos_migrator  owns the schema, runs migrations (created by the image)
--   resortos_app       used by the running API: DML only, no DROP/TRUNCATE/ALTER
CREATE ROLE resortos_app LOGIN PASSWORD 'app_dev_password';
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO resortos_app;
-- Separate throwaway database for automated tests
CREATE DATABASE resortos_test OWNER resortos_migrator;
