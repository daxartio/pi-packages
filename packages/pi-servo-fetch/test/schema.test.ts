import { expect, test } from "bun:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { registerTools } from "../src/index.js";
import {
	FetchParams,
	SessionCloseParams,
	SessionFetchParams,
	SessionListParams,
	SessionOpenParams,
} from "../src/schema.js";

const url = "https://github.com/MinishLab/semble";
const sessionId = "00000000-0000-4000-8000-000000000000";

function schemas(): Map<string, TSchema> {
	const result = new Map<string, TSchema>();
	registerTools({
		registerTool(tool) {
			result.set(tool.name, tool.parameters);
		},
		on() {
			return () => {};
		},
	});
	return result;
}

test("tool schemas have one purpose and do not expose action-dependent optional IDs", () => {
	const registered = schemas();
	expect(registered.has("servo_fetch_session")).toBe(false);
	expect(registered.get("servo_fetch")).toEqual(FetchParams);
	expect(registered.get("servo_fetch_session_open")).toEqual(SessionOpenParams);
	expect(registered.get("servo_fetch_session_fetch")).toEqual(
		SessionFetchParams,
	);
	expect(registered.get("servo_fetch_session_list")).toEqual(SessionListParams);
	expect(registered.get("servo_fetch_session_close")).toEqual(
		SessionCloseParams,
	);
	expect(Object.hasOwn(FetchParams.properties, "sessionId")).toBe(false);
	expect(Object.hasOwn(SessionOpenParams.properties, "sessionId")).toBe(false);
	expect(Object.hasOwn(SessionOpenParams.properties, "action")).toBe(false);
	expect(Object.hasOwn(SessionFetchParams.properties, "format")).toBe(false);
	expect([...(SessionFetchParams.required ?? [])]).toEqual([
		"url",
		"sessionId",
	]);
	expect(SessionCloseParams.required).toEqual(["sessionId"]);
});

test("ordinary page reads require no setup or placeholder session", () => {
	expect(Value.Check(FetchParams, { url })).toBe(true);
	for (const value of ["none", sessionId, null]) {
		expect(Value.Check(FetchParams, { url, sessionId: value })).toBe(false);
	}
});

test("open accepts defaults but never a caller-invented ID or action", () => {
	for (const params of [
		{},
		{ userAgent: null },
		{ userAgent: "Mozilla/5.0" },
	]) {
		expect(Value.Check(SessionOpenParams, params)).toBe(true);
	}
	for (const params of [
		{ action: "open" },
		{ sessionId: "semble-info", userAgent: "Mozilla/5.0" },
		{ sessionId: "assemble", userAgent: "Mozilla/5.0" },
		{ sessionId },
	]) {
		expect(Value.Check(SessionOpenParams, params)).toBe(false);
	}
});

test("session fetch and close require a UUID, never names, placeholders, or missing IDs", () => {
	expect(Value.Check(SessionFetchParams, { url, sessionId })).toBe(true);
	expect(Value.Check(SessionCloseParams, { sessionId })).toBe(true);
	for (const value of [
		undefined,
		null,
		"",
		"none",
		"semble-info",
		"assemble",
	]) {
		expect(Value.Check(SessionFetchParams, { url, sessionId: value })).toBe(
			false,
		);
		expect(Value.Check(SessionCloseParams, { sessionId: value })).toBe(false);
	}
	expect(
		Value.Check(SessionFetchParams, { url, sessionId, format: "markdown" }),
	).toBe(false);
	expect(
		Value.Check(SessionCloseParams, { sessionId, userAgent: "Mozilla/5.0" }),
	).toBe(false);
	expect(Value.Check(SessionListParams, {})).toBe(true);
	expect(Value.Check(SessionListParams, { sessionId })).toBe(false);
});
