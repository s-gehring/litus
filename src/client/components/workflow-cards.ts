export function formatTimer(activeWorkMs: number, activeWorkStartedAt: string | null): string {
	let totalMs = activeWorkMs;
	if (activeWorkStartedAt) {
		totalMs += Date.now() - new Date(activeWorkStartedAt).getTime();
	}

	if (totalMs <= 0) return "0:00";

	const totalSeconds = Math.floor(totalMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		return `${hours}:${String(mins).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}

	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Called every second to update all timer displays
export function updateTimers(): void {
	const timers = document.querySelectorAll<HTMLElement>(".card-timer");
	for (const timer of timers) {
		const ms = parseInt(timer.dataset.activeWorkMs || "0", 10);
		const startedAt = timer.dataset.activeWorkStartedAt || null;
		timer.textContent = formatTimer(ms, startedAt || null);
	}
}
