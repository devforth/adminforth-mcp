---
name: mutate_data
description: Create, update or delete records and run custom actions. Load it before any change.
---

# Tools

get_resource (with detailed: true), get_resource_data, create_record, update_record, delete_record, start_custom_action, start_custom_bulk_action.

# Before any change

- Check that the change is allowed: allowedActions.create, allowedActions.edit or allowedActions.delete must be true. A custom action is allowed when its allowed attribute is true or missing. If the change is not allowed, tell the user instead of trying.
- If the resource has a dedicated action for the task, run the action instead of editing fields. For example, run an approve action instead of setting an approved field: the action may also send notifications or update related data.
- Before updating, deleting or running an action, load the affected record with get_resource_data and show its key fields, so the user can check it is the right record. Describe it from one exact returned row.
- In the planned change show the resource, the record and the values to set. A request such as "create a test car" is not a confirmation of the values you chose.

# Creating

- Pass only columns with showIn.create true and fill every column with required.create true.
- For a column with foreignResource pass the primary key of the related record. If the user names it, for example by email, find it in the related resource first.
- Columns with showIf apply only when its condition matches the record values.
- After creating, report the primary key of the new record.

# Updating

- Change only columns with showIn.edit true.
- Show the changed fields as old value → new value.

# Changing many records

- Every change affects one record per call, except start_custom_bulk_action. Before changing many records, load them with filters, report how many records match, show up to {{pageSize.default}} examples, then get one confirmation for the whole set.
- If the resource has a custom bulk action for the task, prefer start_custom_bulk_action with all record ids in one call.
- If more than {{pageSize.max}} records match, do not change them all at once: tell the user and change one page at a time, asking before each next page.

# After a change

- If the tool returned no error, the change is done: report it without loading the record again.

# Errors

- If a tool returns an error, show it to the user in plain words. Fix the call and retry only when the error makes the fix obvious, for example a missing required field the user already gave; otherwise ask the user.
- If a dedicated action fails, for example because it needs a two-factor verification or another step that only the admin panel UI can provide, do not reach the same result by editing the fields it changes. Tell the user why the action failed and that they can run it in the admin panel.

# Values

- Pass dates and datetimes in ISO 8601, for example 2024-01-01 and 2024-01-01T12:00:00Z.
- Pass decimal values as strings with a dot as the decimal separator.
- Files and images cannot be uploaded through these tools. If such a field is required, tell the user the record cannot be created this way.
