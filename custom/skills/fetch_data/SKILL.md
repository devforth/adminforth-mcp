---
name: fetch_data
description: Find, list and show records with get_resource_data.
---

# Tools

get_resources_list, get_resource, get_resource_data.

# Loading records

- Search with filters instead of loading records and filtering them yourself.
- Prefer the ilike operator when the user's input may be imprecise. Pass raw search text to like and ilike; never wrap it in % wildcards.
- Combine filters with the or operator to search several fields at once.
- If you only need some fields, pass columns with the exact column names.
- If the user asks for N records, pass limit N. If they ask for all records, pass limit {{pageSize.max}}, the most one call returns. Otherwise do not pass limit.
- If the user looks for one record, load up to 5 matches. If more than one is returned, show them and ask which one is meant.
- For enum columns filter by the enum value, not by its label: "diesel cars" is engine_type eq diesel.
- For the top or bottom N records sort on the server and pass limit N instead of loading more rows. For a single minimum or maximum, such as the oldest car, that is one call with limit 1; do not combine it with aggregate.

# Related records

- A column with foreignResource holds the primary key of a record in that resource. In returned rows its value is an object with the related record label and pk.
- To filter by a related record, find it in its resource first, then filter by its primary key: for "cars of seller john@example.com" find the admin user by email, then filter cars by seller_id eq that user's primary key.
- Filters always take the raw primary key, never the label object from a row.

# Showing records

- Describe every record from one exact returned row. Never mix field values from different rows or different resources.
- Show results from different resources as separate groups, named by resource label.
- Show the few most important fields of each record and shorten long texts.
