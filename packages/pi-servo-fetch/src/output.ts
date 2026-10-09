import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

export interface OutputDetails {
	source?: "http" | "servo";
	extraction?: "local-dom";
	contentType?: string;
	selectorIgnored?: boolean;
	fullOutputPath?: string;
	truncated?: boolean;
	screenshotPath?: string;
	bytes?: number;
}

async function saveArtifact(
	name: string,
	data: string | Buffer,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-servo-fetch-"));
	const path = join(directory, name);
	await writeFile(path, data, { mode: 0o600 });
	return path;
}

export async function textResult(
	text: string,
): Promise<AgentToolResult<OutputDetails>> {
	const truncation = truncateHead(text);
	if (!truncation.truncated) {
		return { content: [{ type: "text", text }], details: {} };
	}
	const fullOutputPath = await saveArtifact("output.txt", text);
	return {
		content: [
			{
				type: "text",
				text: `${truncation.content}\n\n[Output truncated. Full output saved to ${fullOutputPath}]`,
			},
		],
		details: { fullOutputPath, truncated: true },
	};
}

export async function jsonResult(
	value: unknown,
): Promise<AgentToolResult<OutputDetails>> {
	const text = JSON.stringify(value, null, 2);
	if (text === undefined) throw new Error("Servo returned no result");
	return textResult(text);
}

export async function screenshotResult(
	png: Buffer,
): Promise<AgentToolResult<OutputDetails>> {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	if (!png.subarray(0, signature.length).equals(signature)) {
		throw new Error("Servo returned an invalid PNG screenshot");
	}
	const screenshotPath = await saveArtifact("screenshot.png", png);
	return {
		content: [
			{ type: "text", text: `PNG screenshot saved to ${screenshotPath}` },
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		],
		details: { screenshotPath, bytes: png.length },
	};
}
