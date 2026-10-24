-- Estimated effort in man-days (MD). Cards other than R4C and Project get
-- their due date from start_date and this, counting weekdays.
alter table kanban.cards add column estimate_days double precision;
