-- Record when each inventory item was physically counted so later stock movements are not overwritten.
alter table count_lines add column if not exists counted_at timestamptz;

-- Existing in-progress counts receive a one-time migration cutover timestamp.
update count_lines
set counted_at = now()
where counted_qty is not null and counted_at is null;
