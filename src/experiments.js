import { validateContract, literalExpectations, relationshipExpectations } from './experiment-contract.js';
export const expectations = ['', ...literalExpectations, ...relationshipExpectations];

export function experimentPlan(action, observation, sourceEvidence = []) {
  if (!action.value) throw new Error('Investigations require a structured experiment plan in value.');
  let plan;
  try {
    plan = JSON.parse(action.value);
  } catch {
    throw new Error('Investigation value must be a JSON experiment plan.');
  }
  const fields = ['capability', 'behavior', 'state', 'preconditions', 'expected', 'basis', 'references', 'checks'];
  if (!plan || Array.isArray(plan) || Object.keys(plan).sort().join() !== [...fields].sort().join())
    throw new Error('Invalid experiment plan fields.');
  for (const key of fields.filter(k => !['references', 'checks'].includes(k)))
    if (typeof plan[key] !== 'string' || !plan[key].trim() || plan[key].length > 500)
      throw new Error(`Experiment requires ${key}.`);
  if (!['documented', 'implementation', 'observed', 'assumption'].includes(plan.basis))
    throw new Error('Unknown expectation basis.');
  if (
    !Array.isArray(plan.references) ||
    plan.references.length > 8 ||
    plan.references.some(r => typeof r !== 'string' || r.length > 200)
  )
    throw new Error('Invalid expectation references.');
  if (
    ['documented', 'implementation'].includes(plan.basis) &&
    (!plan.references.length ||
      plan.references.some(
        ref => !sourceEvidence.some(e => e.result?.path === ref || e.result?.matches?.some(m => m.path === ref)),
      ))
  )
    throw new Error('Source expectations must cite a file already read or found in source search.');
  validateContract(plan.checks);
  return { ...plan, actor: observation.actor };
}

export function coverageSummary(report) {
  return {
    experiments: report.investigations.map(i => ({
      investigationId: i.id,
      capability: i.plan?.capability ?? i.title,
      behavior: i.plan?.behavior ?? 'unspecified',
      actor:
        [
          ...new Set(
            (report.assertions ?? [])
              .filter(a => a.investigationId === i.id)
              .map(a => report.observations.find(o => o.id === a.observationId)?.actor)
              .filter(Boolean),
          ),
        ].join(', ') || i.actor,
      references: i.plan?.references ?? [],
      basis: i.plan?.basis ?? 'unspecified',
      state: i.plan?.state ?? 'unspecified',
      status: i.conclusion?.status ?? 'unfinished',
      reason: i.conclusion?.reason ?? '',
      requiredChecks: i.plan?.checks?.length ?? 0,
      completedChecks: i.progress?.length ?? 0,
      pendingCheck: i.plan?.checks?.[i.progress?.length ?? 0]?.id ?? null,
      assertions: (report.assertions ?? []).filter(a => a.investigationId === i.id).length,
    })),
    pages: report.pages.map(p => ({
      path: p.path,
      visitedBy: p.visitedBy,
      status: p.visitedBy?.length ? 'visited; behavior coverage is separate' : 'unexplored',
    })),
    limitations: ['Coverage describes selected experiments, not exhaustive application coverage.'],
  };
}
