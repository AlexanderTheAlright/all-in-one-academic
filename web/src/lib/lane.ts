/* No alternate request lane in this build: every request goes to the page origin. */
export function installLane(): void {}
export const laneBase = (): string | null => null;
