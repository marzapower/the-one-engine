import { DefaultStateAdapter } from "../core/di/defaults";
import type { EntityRegistry, MutationEvent } from "../core/di/types";

/**
 * Testing-only StateAdapter that records every mutation flowing through the
 * DefaultStateAdapter hooks. Extends the default to inherit every method
 * verbatim (including registry/accessor caching), then just binds the hooks
 * to an internal log. No method override, no delegation boilerplate.
 */
export class MockStateAdapter extends DefaultStateAdapter {
  private mutationLog: MutationEvent[] = [];

  constructor(registry?: EntityRegistry) {
    super(registry);
    this.onAfterMutation = (event) => {
      this.mutationLog.push(event);
    };
  }

  getMutations(): MutationEvent[] {
    return this.mutationLog;
  }

  clearMutations(): void {
    this.mutationLog = [];
  }
}
