-- Property-scoped staff references protect every maintenance write, including raw SQL.
ALTER TABLE users ADD CONSTRAINT users_property_id_id_unique UNIQUE (property_id, id);
ALTER TABLE maintenance_tickets
  ADD CONSTRAINT maintenance_assignee_property FOREIGN KEY (property_id, assigned_to) REFERENCES users(property_id, id),
  ADD CONSTRAINT maintenance_creator_property FOREIGN KEY (property_id, created_by) REFERENCES users(property_id, id),
  ADD CONSTRAINT maintenance_updater_property FOREIGN KEY (property_id, updated_by) REFERENCES users(property_id, id),
  ADD CONSTRAINT maintenance_resolver_property FOREIGN KEY (property_id, resolved_by) REFERENCES users(property_id, id),
  ADD CONSTRAINT maintenance_closer_property FOREIGN KEY (property_id, closed_by) REFERENCES users(property_id, id);
ALTER TABLE maintenance_schedules
  ADD CONSTRAINT maintenance_schedule_creator_property FOREIGN KEY (property_id, created_by) REFERENCES users(property_id, id),
  ADD CONSTRAINT maintenance_schedule_updater_property FOREIGN KEY (property_id, updated_by) REFERENCES users(property_id, id);
