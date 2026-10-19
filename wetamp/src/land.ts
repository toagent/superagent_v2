// Generated deliver-* nodes import this stable entrypoint. Their candidate-based
// behavior stays isolated until those runs have drained.
export * from './land-legacy';

import { runLegacyDeliveryMain } from './land-legacy';

if (import.meta.main) runLegacyDeliveryMain();
