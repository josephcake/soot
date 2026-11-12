/**
 * @intelligent-agent-router/cli
 *
 * STUB: Standalone `orchestrator` CLI (no commands implemented yet).
 * Nothing is implemented here yet; planned for Milestone 6.
 * See ROADMAP.md and TASKS.md. Do not rely on this package.
 */

import { PACKAGE_NAME as CORE_PACKAGE_NAME } from '@intelligent-agent-router/core';

export const PACKAGE_NAME = '@intelligent-agent-router/cli';

/** Implementation status of this package. Becomes 'implemented' only when real code lands. */
export const IMPLEMENTATION_STATUS = 'stub' as const;

/** Milestone in which this package is scheduled to receive its first real implementation. */
export const PLANNED_MILESTONE = 6;

/** The core package this app is built on (proves the workspace link and project reference). */
export const DEPENDS_ON = [CORE_PACKAGE_NAME] as const;
