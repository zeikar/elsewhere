# Ideas

Ideas that came up while building the MVP. As [docs/PLAN.md](docs/PLAN.md) section 5 says, they are recorded here and are not part of the current scope.

## Rendering

- **A cheaper nebula pass.** Nebulae are the largest GPU cost: during an encounter their soft-blended layers cover much of the screen, and every covered pixel runs the noise shader once per layer. One option is to draw the layers into a half-resolution render target and composite it over the stars, since the nebula is soft and has no fine detail to lose. This could be the first step towards PLAN.md's Optional "Quality presets and adaptive resolution", with the nebula resolution as one of the preset values.

## Testing

- **A steadier heap check in the soak.** The soak compares the heap of its last sample with its first, after a forced GC. A single noisy sample at either end can move that result. A steadier measure would compare the GC floor, the minimum heap over the last third of the samples, with the minimum over the first third. A real leak raises the floor, while one-off garbage does not.
