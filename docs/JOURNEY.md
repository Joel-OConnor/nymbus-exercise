# How I approached this, and how AI factored in

Speaking notes for the "story of your approach" part of the meeting. First person, because I'll be saying it out loud.

## The tools

One tool, used throughout: Claude Code, running in the Claude desktop app's Code tab against this repository, with the built-in browser for looking at what was built. No other AI services. No web search was needed; the brief, the ISO 8583 basics, and the platform constraints were enough to design against, and the environment's technologies (Node, Next.js, Postgres, Valkey, Kafka, OpenTelemetry) are all ones I know.

Time invested: **[fill in: roughly N hours over N sittings]**. The build itself was one continuous working session of about five hours, after an initial scaffold-and-read earlier the same day.

## How I worked

The pattern was the same from start to finish: I decide, the AI builds, something verifies. I treated it like pairing with a very fast senior engineer who has no judgment about what the business needs and no memory of what we agreed five minutes ago unless it's written down. So I wrote things down.

**1. Read the brief and scaffold the environment first.** Before any design, I had it read the PDF and extract the constraints the design had to fit: the language and runtime, what infrastructure already existed, the latency rule, the no-external-SaaS rule, the volumes. Then I had it build an empty-but-running skeleton that mirrored that environment: an npm workspace with a Next.js app, a Node service, and a docker-compose of Postgres, Valkey, Kafka, an OTel collector, Prometheus and Grafana. No business logic. I wanted the shape of the environment to be real before I argued with it about design. It also set up the private GitHub repo. Two things broke immediately (a Kafka listener setting, a Tailwind loader that the generated Next config needed), which is exactly why you scaffold first.

**2. Argue about the architecture before writing it.** I asked for a proposed shape with the alternatives and why not. I agreed with the overall shape (connector → Kafka → aggregator → Postgres plus Valkey → API → console, OTel for history) and then made the calls that were mine to make:

- Poll every 2-3 seconds rather than push. The brief says "a few seconds behind live"; polling meets that with nothing to break. Push is a follow-up.
- Keep the last hour of raw transactions so a spike can be drilled to actual transactions. Rollups alone would have left the operator at "something happened".
- Actually wire OpenTelemetry through to Grafana rather than just gesture at it, so the ">24 hours lives in the existing observability stack" claim is demonstrable.
- Make the simulator able to inject conditions live, so the demo is "watch this happen" rather than "imagine this happening".

And I added two constraints the proposal hadn't foregrounded: design and test for the stated upper bounds (150 tps, 50 tenants) with headroom, and use table partitioning anywhere data is dropped on a rolling basis, because deleting millions of rows a day from a live table is a well-known way to hurt Postgres.

**3. Build in layers, verifying each before the next.** Shared types, then the database package, then the emitter, then the simulator, then the aggregator, then the API, then the console. After the backend was up I had it curl every endpoint as both a platform operator and a tenant admin, check row counts and partitions in psql, check the Valkey keys, and check the metrics coming out of the collector, before touching the frontend. Then it opened the console in the browser and clicked through the role switch, the scenario buttons, and the drill-down, with screenshots I could look at.

**4. Try to break it.** This is where the exercise earned its keep. I had it run three tests I'd want to see before trusting the design:

- A 3x surge (about 420 tps for three minutes). Zero drops, one-second lag, the hot path unchanged at two microseconds.
- Stop Kafka for 45 seconds. The first run found two real bugs. The emitter dropped events immediately instead of buffering, because it never marked itself disconnected on a failed send. And the Kafka client library kills its consumer permanently on a class of error that a broker restart produces, which the aggregator wasn't handling. Both fixed, test re-run, and the second run did what the design said: buffered ~6,000 events with no loss, reconnected on its own, and the aggregator caught up from 77 seconds of lag to one second within ten seconds of Kafka returning.
- Load a full day of history and time the queries. The 24-hour platform-wide view came in under a second; tenant views in tens of milliseconds. I also checked whether row-level security was costing anything (it wasn't, measurably).

A later pass through the whole thing, with unit tests and an end-to-end smoke script added, found four more: the console couldn't cancel a scenario because the API's CORS config didn't allow DELETE; clicking a bar on the traffic chart did nothing because the charting library had changed its click event shape between major versions; the API process died outright when Postgres restarted because the connection pool had no error handler; and the emitter's shutdown path set its stop flag before the final flush, so a graceful restart would have discarded the last quarter second of metrics. None of these showed up in a happy-path run. All four showed up the first time something was clicked, restarted, or asserted.

The AI wrote the first version of the emitter with a confident comment describing buffering behaviour the code didn't actually have. The test found it in a minute. That's the honest picture of these tools right now: they produce plausible, well-commented code at a remarkable rate, and the comments are a statement of intent, not evidence. Verification is the job.

**5. Write it down.** Architecture, decisions with pros and cons of every alternative, assumptions, a runbook, a demo script, and this. Partly for the meeting, mostly because writing the decisions doc is how I checked that each choice still held up once the thing was built.

## Where AI helped most

- **Speed on the undifferentiated parts.** The schema, the Kafka producer and consumer plumbing, the Fastify routes, the chart components, the Grafana dashboard JSON. Hours of typing became minutes, and the quality was fine once tested.
- **Breadth of alternatives.** When I asked "what else could we do and why not", I got a credible list (Redis-only, raw events only, embed Grafana, ClickHouse/Timescale/Flink, log-derived metrics) with the real trade-offs, which made the decisions doc mostly editing rather than research.
- **Tireless verification.** It will happily curl twelve endpoints, run EXPLAIN ANALYZE four ways, and script an outage test, which is work I'd be tempted to skip at 9pm.

## Where I had to steer

- Scope. Left alone it would have built more. Each "that's a follow-up, not the slice" was mine.
- Priorities the brief implies but doesn't state: that partitioning strategy matters, that the upper bounds need to be tested not assumed, that the demo needs injectable conditions.
- Trust. Nothing it claimed was accepted without a tool proving it: a curl, a psql count, a screenshot, a log line. The two Kafka bugs are the case for that discipline.

## What I'd do with more time

Server-sent events over Valkey pub/sub to replace polling once there are many viewers. Anomaly flags on the 5-minute rollups ("decline rate 3σ above this tenant's baseline"). A schema registry on the topic. Container images and alert rules. None of it changes the design, which is the point of a thin vertical slice: the risky questions are answered, and what's left is build-out.
