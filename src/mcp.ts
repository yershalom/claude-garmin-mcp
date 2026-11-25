import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env, Props } from "./env";
import { allowedLogin } from "./env";
import { garminGet, GarminError, type Query } from "./garmin";
import { chunkRange, daySpan, MAX_CHUNK_DAYS, MAX_RANGE_DAYS, mergeChunks } from "./ranges";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const range = {
  startDate: date.describe(`First day, inclusive (YYYY-MM-DD). Ranges up to ${MAX_RANGE_DAYS} days are fine.`),
  endDate: date.describe("Last day, inclusive (YYYY-MM-DD)"),
};
const day = { date: date.describe("Calendar day (YYYY-MM-DD)") };

const MAX_CHARS = 200_000;

// Fields Garmin returns that Claude doesn't need and that identify you or where you live:
// owner name/ID/photo URLs on activities, and GPS start/end points (often your front door).
const DROP_KEY = /^(owner|userProfilePk$|userProfilePK$|userId$)|(Latitude|Longitude)$|^(polyline|geoPolylineDTO)$/i;

export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!DROP_KEY.test(k)) out[k] = scrub(v);
    return out;
  }
  return value;
}

function result(data: unknown) {
  let text = JSON.stringify(scrub(data), null, 1) ?? "null";
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n…[truncated: ask for a shorter range]";
  return { content: [{ type: "text" as const, text }] };
}

function failure(err: unknown) {
  const message = err instanceof GarminError ? err.message : `Unexpected error: ${(err as Error)?.message ?? err}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

type Shape = Record<string, z.ZodType>;

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "garmin-mcp", version: "0.1.0" });

  const tool = <S extends Shape>(
    name: string,
    description: string,
    inputSchema: S,
    call: (args: z.infer<z.ZodObject<S>>) => [string, Query?],
  ) => {
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        try {
          if (inputSchema !== (range as unknown)) {
            const [path, query] = call(args);
            return result(await garminGet(env, path, query));
          }
          // Date-range tool: Garmin allows at most 28 days per request, so split longer ranges.
          const span = daySpan(args.startDate, args.endDate);
          if (!(span >= 1)) throw new GarminError(400, "endDate must be on or after startDate.");
          if (span > MAX_RANGE_DAYS) throw new GarminError(400, `Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
          const parts: unknown[] = [];
          for (const [startDate, endDate] of chunkRange(args.startDate, args.endDate, MAX_CHUNK_DAYS)) {
            const [path, query] = call({ ...args, startDate, endDate });
            parts.push(await garminGet(env, path, query));
          }
          return result(mergeChunks(parts));
        } catch (err) {
          return failure(err);
        }
      }) as never,
    );
  };

  tool("get_daily_summaries", "Daily summary per day: steps, calories, distance, intensity minutes, resting heart rate, stress, Body Battery.", range,
    (a) => ["/usersummary-service/v2/dailysummaries", { startDate: a.startDate, endDate: a.endDate }]);

  tool("get_daily_steps", "Total steps and step goal per day.", range,
    (a) => [`/usersummary-service/stats/steps/daily/${a.startDate}/${a.endDate}`]);

  tool("get_daily_stress", "Average and max stress per day.", range,
    (a) => [`/usersummary-service/stats/stress/daily/${a.startDate}/${a.endDate}`]);

  tool("get_sleep_summaries", "Sleep summary per night (matched to the day you woke up): duration, stages, score.", range,
    (a) => ["/sleep-service/sleep/dailySleepSummariesByDate", { startDate: a.startDate, endDate: a.endDate }]);

  tool("get_sleep_detail", "Detailed sleep for one night, including stage timeline, HR, SpO2 and respiration when available.", day,
    (a) => ["/sleep-service/sleep/dailySleep", { date: a.date }]);

  tool("get_daily_heart_rate", "Heart rate through one day, plus resting, min and max HR. Large: ask for one day at a time.", day,
    (a) => ["/wellness-service/wellness/dailyHeartRate", { date: a.date }]);

  tool("get_hrv_summaries", "Overnight heart rate variability (HRV) summary per day, with baseline and status.", range,
    (a) => [`/hrv-service/hrv/daily/${a.startDate}/${a.endDate}`]);

  tool("get_body_battery", "Body Battery per day: charged, drained, highest and lowest.", range,
    (a) => ["/wellness-service/wellness/bodyBattery/reports/daily", { startDate: a.startDate, endDate: a.endDate }]);

  tool("get_spo2", "Blood oxygen (SpO2) for one day.", day,
    (a) => [`/wellness-service/wellness/daily/spo2acclimation/${a.date}`]);

  tool("get_weight", "Weight and body-composition measurements in a date range.", range,
    (a) => [`/weight-service/weight/range/${a.startDate}/${a.endDate}`]);

  tool("get_vo2_max", "VO2 Max estimates per day.", range,
    (a) => [`/metrics-service/metrics/maxmet/daily/${a.startDate}/${a.endDate}`]);

  tool("get_fitness_age", "Fitness age on a given day.", day,
    (a) => [`/fitnessage-service/fitnessage/v2/${a.date}`]);

  tool("get_hydration", "Hydration log per day.", range,
    (a) => [`/usersummary-service/stats/hydration/daily/${a.startDate}/${a.endDate}`]);

  tool(
    "search_activities",
    "List recorded activities (walks, strength training, swims…) newest first, optionally filtered by date and parent activity type.",
    {
      startDate: date.optional().describe("First day, inclusive (YYYY-MM-DD)"),
      endDate: date.optional().describe("Last day, inclusive (YYYY-MM-DD)"),
      activityType: z.string().optional().describe("Parent activity type key, e.g. walking, fitness_equipment. See list_activity_types."),
      start: z.number().int().min(0).default(0).describe("Offset for paging"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    (a) => ["/activitylist-service/activities/search/activities", { startDate: a.startDate, endDate: a.endDate, activityType: a.activityType, start: a.start, limit: a.limit }],
  );

  tool("get_activity", "Full details for one activity by ID (from search_activities).", { activityId: z.union([z.number().int(), z.string().regex(/^\d+$/)]) },
    (a) => [`/activity-service/activity/${a.activityId}`]);

  tool("get_activity_workouts", "Sets and reps logged for a strength workout activity.", { activityId: z.union([z.number().int(), z.string().regex(/^\d+$/)]) },
    (a) => [`/activity-service/activity/${a.activityId}/workouts`]);

  tool("list_activity_types", "Activity type keys and their parents, for filtering search_activities.", {},
    () => ["/activity-service/activity/activityTypes/simple"]);

  tool("get_heart_rate_zones", "Your heart rate zones as configured in Garmin Connect.", {},
    () => ["/biometric-service/heartRateZones/v2"]);

  tool("get_profile_settings", "Profile settings: units, time zone, height, weight, etc.", {},
    () => ["/userprofile-service/userprofile/settings"]);

  return server;
}

/** Stateless MCP over Streamable HTTP. Reached only after the OAuth provider has validated the token. */
export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
    if (!ctx.props?.login || ctx.props.login.toLowerCase() !== allowedLogin(env)) {
      return new Response("Forbidden", { status: 403 });
    }
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
