import assert from "node:assert/strict";
import { test } from "node:test";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import {
	createRuntimeHarness,
	emitQueuedTurnThroughContext,
	goalUserContextMessage,
	queuedCustomMessage,
	requireProviderContextResult,
} from "./support/runtime-harness.js";

for (const messageType of ["user", "custom"] as const) {
	test(`${messageType} before-agent-start preserves stale continuation cancellation`, async () => {
		const harness = createRuntimeHarness();
		await harness.runCommand("ship it");
		const queued = harness.sentMessages[0];
		assert.ok(queued);
		const prompt = queued.message.content;
		assert.equal(typeof prompt, "string");
		if (typeof prompt !== "string") assert.fail("Expected continuation text");
		await harness.runTool("update_goal", { status: "complete" });

		const event: BeforeAgentStartEvent = {
			type: "before_agent_start",
			systemPrompt: "base prompt",
			systemPromptOptions: {
				cwd: process.cwd(),
				selectedTools: [],
				hiddenTools: [],
				toolSnippets: {},
				toolGuidelines: {},
				promptGuidelines: [],
				appendSystemPrompt: "",
				sections: {},
				contextFiles: [],
				skills: [],
			},
			...(messageType === "user"
				? { messageType, prompt }
				: {
						messageType,
						message: { ...queued.message, role: "custom", timestamp: 1 },
					}),
		};
		await harness.emit("before_agent_start", event);
		assert.equal(harness.abortCount, 0);
		const message =
			messageType === "user"
				? goalUserContextMessage(prompt, 1)
				: queuedCustomMessage(queued);
		const results = await emitQueuedTurnThroughContext(harness, [message]);
		requireProviderContextResult(results);
		assert.equal(harness.abortCount, 1);
		assert.equal(harness.snapshot().goal?.status, "complete");
	});
}
