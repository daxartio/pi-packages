import type { TaskStatus } from "../tool/types.js";

export function t(_key: string, fallback: string): string {
	return fallback;
}

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in progress";
		case "completed":
			return "completed";
		case "deleted":
			return "deleted";
	}
}
