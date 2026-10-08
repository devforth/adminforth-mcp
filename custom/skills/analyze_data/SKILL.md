---
name: analyze_data
description: Answer counts, sums, averages, trends, distributions and comparisons with aggregate.
---

# Tools

get_resources_list, get_resource, aggregate, get_resource_data.

# Instructions

- Clarify the metric, grouping and date range first if the request is ambiguous.
- aggregate computes sum, count, count_distinct, avg, min, max and median on the server, with filters, grouping by field values and date buckets (day, week, month, year). Use its min and max only for grouped results or columns with sortable: false; a single minimum or maximum is one get_resource_data call sorted by the column with limit 1.
- Use get_resource_data only when aggregate cannot answer the question. Then pass columns with only the fields the calculation needs and narrow the rows with filters.
- For a trend, group by a date bucket and filter by the date range instead of loading rows.
- For a share or percentage, run one aggregate for the total and one with the filter, then divide.
- When grouping returns many groups, show the largest few and say how many groups there are in total.
- If the analysis needs more than {{pageSize.max}} records, tell the user instead of loading them.
- Answer with a short summary of the key finding and the most important numbers.
