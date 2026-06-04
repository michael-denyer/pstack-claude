# Datadog Telemetry

## What this source contains

Datadog holds the runtime record of the system, what actually happened in production, as opposed to what was planned or discussed. For "why" questions, the useful layers are:

- **Metrics.** Counters, gauges, histograms instrumented by the team. The *presence* of a metric is itself evidence: someone thought this number was worth watching.
- **Monitors & alerts.** The conditions the team decided warranted waking someone up. A monitor that fires on `rate_limit_hit > 10/min` is direct evidence the team worried about that threshold.
- **Dashboards.** Curated views. The charts on a dashboard tell you what the team considers important for a subsystem.
- **APM traces & spans.** Request-level runtime data. Useful for "why is this function slow" / "why is there a timeout here" questions.
- **Logs.** High-volume event records. Often contain error conditions that motivated defensive code.
- **Incidents.** Formal incident records with timelines and postmortems linked.
- **Notebooks.** Exploratory investigations the team has done; often contain hypotheses and analyses.

Datadog evidence answers "what was the production reality around the time this code was written?", which often explains why the code has its particular shape.

## How to search it

Use the Datadog MCP available in your environment. Start broad, then narrow.

1. **Context about the owning service.** Before diving in, identify which service(s) the target code belongs to:

   ```
   search_datadog_services (filter by name or team)
   search_datadog_service_dependencies (see upstream/downstream)
   ```

2. **Dashboards and monitors first. They tell you what the team cares about.**

   ```
   search_datadog_dashboards (query: feature name, service name, symbol)
   search_datadog_monitors   (same queries)
   ```

   When you find a dashboard or monitor that covers the target, note the queries it runs and the thresholds it watches. The threshold itself is frequently the answer to a "why is this clamped at N?" question.

3. **Metrics around the target.**

   ```
   search_datadog_metrics (by name pattern, e.g., the feature or symbol)
   get_datadog_metric_context (for metadata: description, units, tags)
   get_datadog_metric (timeseries, useful for "was there a spike around the PR date?")
   ```

   If you can correlate a metric's trajectory with when the target code was added or changed, that's strong supporting evidence: "the `payment_timeout` metric shows a spike on 2023-11-03, and the retry logic was merged 2023-11-06."

4. **Logs. Narrow, don't dump.**

   ```
   search_datadog_logs (look at raw log patterns near the target, set use_log_patterns=true)
   analyze_datadog_logs (SQL-style aggregations, only when you need counts)
   ```

   Search with symbols, error strings, or feature names. **Strongly prefer time-bounded queries** scoped to a window around the change (e.g., 30 days before/after). Datadog log volume is huge and unconstrained searches waste time and may time out.

5. **APM spans and traces.**

   ```
   aggregate_spans    (for stats: "how often does this endpoint fail?")
   search_datadog_spans (for inspecting individual spans)
   get_datadog_trace  (for a specific trace ID)
   ```

   Useful for questions about timeouts, retries, slow paths, and cross-service behavior.

6. **Incidents.**

   ```
   search_datadog_incidents (by title, team, date range)
   get_datadog_incident     (full detail for a specific incident)
   ```

   If the target code looks defensive, search for incidents around the time it was added. An incident whose timeline includes "added defensive check for X" is near-direct evidence.

## What good evidence looks like here

- A monitor whose query and threshold match the exact constraint the code enforces (e.g., code clamps to 100; monitor alerts when requests exceed 100/min)
- A dashboard created by the target's author, with widgets that correspond to what the code measures or guards against
- A metric that shows a production spike immediately before the code was merged, and stable values after
- An incident record that references the target code, the same symbols, or the same error strings
- Logs showing a specific error pattern that the defensive code would prevent, timestamped in the window before the change

## Common pitfalls

- **Correlation is not causation.** A metric spike before a PR and stabilization after is suggestive but not definitive. Other changes may have landed in the same window. Always check neighboring PRs.
- **Overfitting to the chart you found.** Datadog visualizations are *made* by humans and reflect that human's framing. A chart named "retry success rate" is evidence the team cared about retry success, not necessarily that it's why a specific line of code exists.
- **Vanished telemetry.** Metrics can be renamed, deleted, or have short retention. If you can't find data from the relevant window, that's a gap, not a null result.
- **Noise at scale.** Searching logs for a common string will return thousands of matches. Narrow by service, tag, and time window aggressively. Use `analyze_datadog_logs` to aggregate rather than dumping raw logs.
- **Instrumented != caused.** The existence of a metric tells you someone cared enough to measure something. It doesn't tell you that the code you're investigating was added *because* of the metric. Cross-reference with commit/PR dates.

## What to return

For each relevant item:
- Type (dashboard / monitor / metric / log pattern / trace / incident / notebook)
- Title or name
- Link or identifier (dashboard ID, monitor ID, metric name, incident ID)
- Owner/author and created/modified date
- The specific condition, query, or quote that bears on the question (verbatim where possible)
- Relevance: what this suggests about the target code, and how strong the connection is
