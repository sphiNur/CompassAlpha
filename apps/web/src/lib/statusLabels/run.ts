import type { RunStatus } from '@compass/contracts/schemas/run';
import type { CatalogKey } from '@compass/i18n';
import { labelIn, type Translate } from './table';

const RUN_STATUS: Record<RunStatus, CatalogKey> = {
  planned: 'run.status.planned',
  purchasing: 'run.status.purchasing',
  delivering: 'run.status.delivering',
  finished: 'run.status.finished',
  amending: 'run.status.amending',
  cancelled: 'run.status.cancelled',
};

/** RE-COPY-1: the step a run is at, as the run switcher names it. */
const RUN_STEP: Record<RunStatus, CatalogKey> = {
  planned: 'run.step.plan',
  purchasing: 'run.step.purchase',
  delivering: 'run.step.deliver',
  finished: 'run.step.done',
  amending: 'run.step.amend',
  cancelled: 'run.status.cancelled',
};

export function runStatusLabel(i18n: Translate, status: string | null | undefined): string {
  return labelIn(i18n, RUN_STATUS, status);
}

export function runStepLabel(i18n: Translate, status: string | null | undefined): string {
  return labelIn(i18n, RUN_STEP, status);
}
