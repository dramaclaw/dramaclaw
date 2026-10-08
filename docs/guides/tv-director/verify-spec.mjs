#!/usr/bin/env node
/**
 * Why: coverage must be reproducible without pretending that planned cases
 * are passing product tests. Read-only: no credentials, network or model calls.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const read = name => fs.readFileSync(path.join(directory, name), "utf8");
const map = JSON.parse(read("implementation-map.json"));
const inventory = JSON.parse(read("source-inventory.json"));
const policy = JSON.parse(read("acceptance-policy.json"));
const closure = JSON.parse(read("plan-closure.json"));
const docs = {
  feature: read("feature-contracts.md"), skill: read("skill-contracts.md"),
  workflow: read("workflow-contracts.md"), acceptance: read("acceptance-contracts.md"),
};
const ids = (text, pattern) => [...text.matchAll(pattern)].map(match => match[1]);
const expected = {
  requirements: ids(docs.feature, /^\| ([AODEQSRKXC]\d{2})(?:\s+[^|]+)? \|/gm),
  methods: ids(docs.skill, /^### (M\d{2}) /gm),
  rules: ids(docs.skill, /^\| (G\d{2}) \|/gm),
  transitions: ids(docs.workflow, /^\| (WT\d{2}) \|/gm),
  fixtures: ids(docs.acceptance, /^\| (F\d{2}) \|/gm),
  qualityGroups: ids(docs.acceptance, /^\| (B\d{2}) \|/gm),
  sourceChecks: ids(docs.acceptance, /^\| (N\d{2}) \|/gm),
};
const groups = { A: 26, O: 16, D: 9, Q: 9, S: 7, E: 32, R: 18, K: 20, X: 12, C: 8 };
const fixedIds = Object.entries(groups).flatMap(([prefix, count]) =>
  Array.from({ length: count }, (_, i) => prefix + String(i + 1).padStart(2, "0")));
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const repoFile = p => typeof p === "string" && !path.isAbsolute(p) &&
  !p.split("/").includes("..") && fs.existsSync(path.join(root, p)) &&
  fs.statSync(path.join(root, p)).isFile();
const safePlanPath = p => typeof p === "string" &&
  /^(src\/novelvideo\/director\/|frontend\/src\/features\/director\/|frontend\/src\/__tests__\/|tests\/)/.test(p) &&
  !p.includes("..") && !p.includes("*") && !p.endsWith("/") && !p.includes("undefined");

function validate(candidate, source) {
  const errors = [];
  const check = (ok, reason) => { if (!ok) errors.push(reason); };
  const indexes = {};
  for (const name of ["requirements", "methods", "rules", "transitions", "fixtures", "tests",
    "commands", "transports", "schemas", "differences", "qualityGroups", "sourceChecks"]) {
    const entries = candidate[name];
    check(Array.isArray(entries) && entries.length > 0, name + ": missing list");
    indexes[name] = new Map();
    for (const entry of entries ?? []) {
      check(nonempty(entry.id), name + ": empty id");
      check(!indexes[name].has(entry.id), name + ": duplicate " + entry.id);
      indexes[name].set(entry.id, entry);
    }
  }
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  check(sameSet(expected.requirements, fixedIds), "Markdown action/capability denominator changed");
  for (const [name, wanted] of Object.entries(expected))
    check(sameSet([...indexes[name].keys()], wanted), name + ": Markdown/index ID mismatch");
  const counts = { actions: 149, capabilities: 8, methods: 24, rules: 18, transitions: 33,
    fixtures: 33, qualityGroups: 12, sourceChecks: 10 };
  for (const [key, value] of Object.entries(counts))
    check(candidate.counts[key] === value, "Wrong denominator: " + key);
  check(candidate.requirements.filter(x => x.kind === "action").length === 149, "149 actions required");
  check(candidate.requirements.filter(x => x.kind === "capability").length === 8, "8 capabilities required");
  const references = (owner, name, values, allowEmpty = false) => {
    check(Array.isArray(values) && (allowEmpty || values.length > 0), owner + ": empty " + name);
    for (const id of values ?? []) check(indexes[name].has(id), owner + ": unknown " + name + "/" + id);
  };
  const resultStatus = entry => {
    if (entry.status === undefined) return;
    check(["not_implemented", "implemented_unverified", "pass", "fail", "blocked",
      "planned_not_executable", "not_run"].includes(entry.status), entry.id + ": invalid status");
    if (entry.status === "pass") {
      check(repoFile(entry.resultRef), entry.id + ": PASS needs real result file");
      check(entry.evidenceKind === "product_execution", entry.id + ": spec check is not product PASS");
    }
  };
  for (const entry of candidate.requirements) {
    check(repoFile(entry.contractRef), entry.id + ": broken contract");
    check(safePlanPath(entry.componentPath), entry.id + ": unsafe/unspecified component");
    check(entry.useCasePaths?.length > 0 && entry.useCasePaths.every(safePlanPath), entry.id + ": missing use-case path");
    check(entry.designStatus === "ready", entry.id + ": design not resolved");
    check(/^P[0-8]$/.test(entry.stage), entry.id + ": invalid phase");
    references(entry.id, "commands", entry.commands);
    references(entry.id, "transports", entry.transportIds);
    references(entry.id, "schemas", entry.schemaRefs);
    references(entry.id, "methods", entry.methodIds, true);
    check(nonempty(entry.methodBindingPolicy), entry.id + ": method policy missing");
    references(entry.id, "rules", entry.ruleIds);
    references(entry.id, "fixtures", entry.fixtureIds);
    references(entry.id, "tests", entry.testIds);
    references(entry.id, "differences", entry.differenceIds, true);
    check(entry.testIds?.length >= 2, entry.id + ": positive and negative required");
    check(entry.evidenceRefs?.length > 0 && entry.evidenceRefs.every(repoFile), entry.id + ": evidence path missing");
    for (const commandId of entry.commands ?? []) {
      const cmd = indexes.commands.get(commandId);
      if (!cmd) continue;
      check(cmd.requirementIds.includes(entry.id), entry.id + ": command inverse missing");
      check(entry.transportIds.includes(cmd.transportId), entry.id + ": command transport omitted");
      check(entry.schemaRefs.includes(cmd.inputSchema) && entry.schemaRefs.includes(cmd.outputSchema),
        entry.id + ": input/output schema omitted");
    }
    resultStatus(entry);
  }
  for (const method of candidate.methods) {
    check(repoFile(method.contractRef), method.id + ": contract missing");
    check(safePlanPath(method.packagePath) && safePlanPath(method.useCasePath), method.id + ": missing package/code path");
    check(method.requiredFiles.length === 7, method.id + ": incomplete method package");
    check(nonempty(method.inputContract) && nonempty(method.outputContract), method.id + ": input/output missing");
    references(method.id, "fixtures", method.fixtureIds);
    references(method.id, "tests", method.testIds);
    check(method.testIds.includes("METHOD-" + method.id + "-positive") &&
      method.testIds.includes("METHOD-" + method.id + "-negative"), method.id + ": missing polarity");
    check(method.sourceRefs.length > 0 && method.sourceRefs.every(p => source.files.some(f => f.path === p)),
      method.id + ": missing frozen source");
    resultStatus(method);
  }
  for (const rule of candidate.rules) {
    check(nonempty(rule.sourceAndTrigger) && nonempty(rule.behavior) && nonempty(rule.disableOrConflict),
      rule.id + ": trigger/disable/conflict missing");
    check(safePlanPath(rule.validatorPath), rule.id + ": validator path missing");
    references(rule.id, "tests", rule.testIds);
    for (const suffix of ["enabled", "disabled", "conflict"])
      check(rule.testIds.includes("RULE-" + rule.id + "-" + suffix), rule.id + ": missing " + suffix);
    check(rule.sourceRefs.every(p => source.files.some(f => f.path === p)), rule.id + ": source missing");
    resultStatus(rule);
  }
  for (const state of candidate.transitions) {
    check([state.from, state.event, state.guard, state.to].every(nonempty), state.id + ": incomplete transition");
    check(safePlanPath(state.useCasePath), state.id + ": code path missing");
    references(state.id, "tests", state.testIds);
    for (const suffix of ["allowed", "guard_rejected"])
      check(state.testIds.includes("STATE-" + state.id + "-" + suffix), state.id + ": missing " + suffix);
    resultStatus(state);
    const row = docs.workflow.split("\n").find(line => line.startsWith(`| ${state.id} |`));
    const cells = row?.split("|").slice(1, -1).map(cell => cell.trim());
    check(cells && [state.from, state.event, state.guard, state.to].every((value, i) => value === cells[i + 1]),
      state.id + ": workflow Markdown and machine transition differ");
  }
  for (const fixture of candidate.fixtures) {
    check([fixture.input, fixture.expected].every(nonempty), fixture.id + ": empty fixture contract");
    check(safePlanPath(fixture.plannedPath), fixture.id + ": fixture path missing");
    check(["positive", "negative"].every(p => fixture.variants.includes(p)), fixture.id + ": fixture polarity");
    check(candidate.requirements.some(r => r.fixtureIds.includes(fixture.id)) ||
      candidate.methods.some(m => m.fixtureIds.includes(fixture.id)), fixture.id + ": unreferenced fixture");
    resultStatus(fixture);
  }
  for (const test of candidate.tests) {
    check(nonempty(test.scenario) && safePlanPath(test.plannedPath), test.id + ": planned test incomplete");
    references(test.id, "fixtures", test.fixtureIds, true);
    check(["not_run", "pass", "fail", "blocked"].includes(test.executionStatus), test.id + ": invalid execution status");
    if (test.executionStatus === "pass") check(repoFile(test.resultRef), test.id + ": fake test PASS");
    check(["requirements", "methods", "rules", "transitions"].some(name =>
      indexes[name].get(test.ownerId)?.testIds.includes(test.id)), test.id + ": orphan test");
  }
  for (const command of candidate.commands) {
    references(command.id, "transports", [command.transportId]);
    references(command.id, "schemas", [command.inputSchema, command.outputSchema]);
    references(command.id, "requirements", command.requirementIds);
    check(Array.isArray(command.requiredFields), command.id + ": required field list missing");
    const input = indexes.schemas.get(command.inputSchema);
    for (const field of command.requiredFields ?? [])
      check(new RegExp("(?:^|; )" + field + "\\??:").test(input?.shape ?? ""), command.id + ": unknown required field " + field);
    for (const branch of command.conditionalFields ?? []) {
      for (const field of [...Object.keys(branch.when), ...branch.require, ...branch.forbid])
        check((input?.shape ?? "").split("; ").some(part => part.startsWith(field + ":") || part.startsWith(field + "?:")), command.id + ": unknown conditional field " + field);
      check(!branch.require.some(field => branch.forbid.includes(field)), command.id + ": contradictory variant");
    }
    check(command.validationRefs?.length === command.requirementIds.length, command.id + ": constraint missing");
    check(nonempty(command.validationPolicy) && nonempty(command.costPolicy), command.id + ": boundary/fee missing");
    for (const id of command.requirementIds)
      check(indexes.requirements.get(id)?.commands.includes(command.id), command.id + ": inverse mismatch");
  }
  for (const api of candidate.transports) {
    check(["local", "GET", "POST"].includes(api.method) && nonempty(api.route), api.id + ": route invalid");
    references(api.id, "schemas", [api.inputSchema, api.outputSchema]);
    check(candidate.commands.some(c => c.transportId === api.id), api.id + ": unused endpoint");
    check(api.method === "local" || api.route.startsWith("/projects/{project}/director/v2/"), api.id + ": unversioned route");
  }
  for (const schema of candidate.schemas) {
    check(nonempty(schema.shape) && repoFile(schema.definitionRef), schema.id + ": schema missing");
    check(schema.additionalProperties === false, schema.id + ": permissive payload");
  }
  check(source.files.length === 24, "source inventory must include all 24 frozen files");
  const sourcePaths = new Set();
  for (const file of source.files) {
    check(!sourcePaths.has(file.path), "duplicate source file " + file.path);
    sourcePaths.add(file.path);
    check(/^[a-f0-9]{64}$/.test(file.sha256), "invalid source hash " + file.path);
    check(!path.isAbsolute(file.path) && !file.path.includes(".."), "unsafe source path");
    check(file.originMatch === true, "source copies differ: " + file.path);
    check(nonempty(file.disposition), "source disposition missing");
  }
  check(source.knowledge.ruleCount === 0 && source.knowledge.exemplarCount === 0, "fabricated knowledge");
  check(candidate.sourceRoutes.length === 15, "missing short-drama route");
  for (const route of candidate.sourceRoutes) {
    check(sourcePaths.has(route.sourceRef), route.sourceCommand + ": no source");
    references(route.sourceCommand, "methods", route.methodIds);
    references(route.sourceCommand, "fixtures", route.fixtureIds);
    check(nonempty(route.policy), route.sourceCommand + ": routing policy missing");
  }
  check(candidate.differences.length === 13, "difference register incomplete");
  for (const diff of candidate.differences) {
    check(diff.designStatus === "decided" && [diff.decision, diff.owner, diff.releaseGate].every(nonempty),
      diff.id + ": unresolved/ownerless decision");
    check(diff.sourceParity === "not_claimed", diff.id + ": unknown source became parity");
    references(diff.id, "methods", diff.methodIds);
    references(diff.id, "fixtures", diff.fixtureIds);
  }
  check(candidate.baseline.existingPaths.every(repoFile), "baseline path missing");
  for (const quality of candidate.qualityGroups)
    check(quality.runsPerSide === 2, quality.id + ": quality denominator weakened");
  return errors;
}

function validateParity(candidate, config) {
  const errors = [];
  const check = (ok, reason) => { if (!ok) errors.push(reason); };
  const tracking = candidate.executionTracking;
  const rows = tracking?.requirements ?? [];
  check(repoFile(candidate.acceptancePolicyRef), "Missing authoritative acceptance policy");
  check(tracking?.policyId === config.policyId, "Tracking/policy version mismatch");
  check(rows.length === fixedIds.length && new Set(rows.map(x => x.id)).size === fixedIds.length &&
    rows.every(x => fixedIds.includes(x.id)), "Execution tracking must cover every requirement exactly once");
  const stageIds = (config.stages ?? []).map(x => x.id);
  check(stageIds.length === 11 && stageIds.every((id, i) => id === `S${i}`), "S0-S10 stage order missing");
  for (const stage of config.stages ?? []) {
    check(stage.dependsOn.every(id => stageIds.indexOf(id) >= 0 && stageIds.indexOf(id) < stageIds.indexOf(stage.id)),
      stage.id + ": missing/cyclic prerequisite");
    if (["S1", "S2"].includes(stage.id)) {
      const wanted = ids(docs.acceptance, new RegExp("^\\| (" + stage.id + "-\\d{2}) \\|", "gm"));
      check(wanted.length > 0 && wanted.length === stage.requiredCases?.length &&
        wanted.every(id => stage.requiredCases.includes(id)), stage.id + ": mandatory cases dropped");
    }
  }
  check(config.stages.find(x => x.id === "S6")?.orderedSubgates?.join("|") ===
    "omni_canvas_and_batch|directing_and_media_handoff", "Omni/director execution order missing");
  for (const row of rows) {
    const old = candidate.requirements.find(x => x.id === row.id);
    check(old?.stage === row.legacyStage, row.id + ": legacy phase provenance lost");
    check(row.deliveryStages?.length > 1 && row.deliveryStages.every(id => stageIds.includes(id)) &&
      row.deliveryStages.includes("S10"), row.id + ": delivery stage missing");
    check(["not_indexed", "unknown", "partial_observed", "observed", "observed_failure"].includes(row.sourceEvidence?.status),
      row.id + ": source evidence status invalid");
    check(["not_audited", "observed_partial", "observed_missing", "validated"].includes(row.implementation?.auditStatus),
      row.id + ": implementation audit status invalid");
    check(Array.isArray(row.sourceEvidence?.caseBindings) && Array.isArray(row.implementation?.caseBindings),
      row.id + ": missing independent case bindings");
    if (row.implementation?.auditStatus.startsWith("observed_"))
      check(row.implementation.observedCodeRefs?.length > 0 &&
        row.implementation.observedCodeRefs.every(ref => repoFile(ref.path) && nonempty(ref.finding)),
      row.id + ": observed implementation needs actual code evidence");
    if (row.implementation?.auditStatus === "validated")
      check(row.implementation.caseBindings?.some(c => c.evidenceKind === "product_execution" && repoFile(c.resultRef)),
        row.id + ": validated cannot be a documentation check");
    if (["partial_observed", "observed", "observed_failure"].includes(row.sourceEvidence?.status))
      check(row.sourceEvidence.caseBindings?.some(c => nonempty(c.sourceCaseId) && repoFile(c.reportRef)),
        row.id + ": observed source needs case provenance");
  }
  check(/^[a-f0-9]{40}$/.test(candidate.baseline.gitCommit), "Current baseline must use full commit SHA");
  check(candidate.baseline.dirtySnapshotFiles?.length > 0, "Dirty implementation baseline omitted");
  for (const file of candidate.baseline.dirtySnapshotFiles ?? []) {
    check(repoFile(file.path) && /^[a-f0-9]{64}$/.test(file.sha256), "Invalid dirty baseline entry");
    if (repoFile(file.path)) {
      const hash = createHash("sha256").update(fs.readFileSync(path.join(root, file.path))).digest("hex");
      check(hash === file.sha256, file.path + ": baseline changed; re-audit instead of reusing old results");
    }
  }
  check(config.modelPolicy.local === "doubao-seed-evolving" && config.modelPolicy.reference === "Seed" &&
    config.modelPolicy.allowSilentFallback === false && config.modelPolicy.allowDefaultMultiModelComparison === false,
  "Only Seed pairing is authorized by the current policy");
  check(config.visual.allowMaskResizeBlurOrAlignmentForPass === false &&
    config.visual.regionMetrics === "diagnostic_only" && config.visual.unmatchedDynamicState === "not_comparable",
  "Visual gate must not pass masked/cropped/unmatched states");
  for (const state of ["partially_accepted", "all_rejected", "save_failed", "conflict", "refresh_restored", "reentered"])
    check(config.visual.states.includes(state), "Missing visual operation state: " + state);
  check(config.literary.scale.join(",") === "1,5", "Unified literary scale missing");
  check(config.literary.fullSamplesPerSide === config.literary.fullGroups.length * config.literary.runsPerFullGroupPerSide &&
    config.literary.fullGroups.join(",") === expected.qualityGroups.join(","), "Full literary denominator mismatch");
  check(config.literary.stageSingleReviewerResult === "provisional_not_full_parity" &&
    config.literary.independentReviewersForFullGate >= 2, "Single reviewer is not full quality acceptance");
  check(config.documentLifecycle.kinds.join(",") === "outline,characters,locations,props,episode" &&
    config.documentLifecycle.operations.join(",") === "generate,view,chat_revise,diff_review,edit_save,refresh_restore,downstream_read" &&
    config.documentLifecycle.minimumCells === config.documentLifecycle.kinds.length * config.documentLifecycle.operations.length &&
    config.documentLifecycle.sameDocumentAcrossSurfacesNotSameVersionAcrossDocuments === true,
  "Five independent document lifecycles required");
  return errors;
}

function validateClosure(value, candidate, config, localEvidence = false) {
  const errors = [];
  const check = (ok, reason) => { if (!ok) errors.push("closure: " + reason); };
  const same = (a, b) => Array.isArray(a) && a.length === b.length &&
    new Set(a).size === a.length && a.every(x => b.includes(x));
  const sha = p => createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex");
  check(value.scope === "implementation_plan_closure_not_product_acceptance", "scope changed");
  check(value.claimBoundary?.allSourceStatesProven === false &&
    value.claimBoundary?.hiddenSourceSkillsRecovered === false &&
    value.claimBoundary?.productAcceptance === "not_run" &&
    value.claimBoundary?.sourceBundleIsNotPerButtonPass === true, "invented acceptance/source recovery");
  check(value.baseline?.gitCommit === candidate.baseline.gitCommit, "baseline differs");
  check(candidate.executionTracking.closureRef === "docs/guides/tv-director/plan-closure.json", "authority missing");
  check(same(value.requirements?.map(x => x.id), fixedIds), "157 requirements required exactly once");
  const groups = new Map((value.auditGroups ?? []).map(x => [x.id, x]));
  check(groups.size === 22, "bounded audit groups missing");
  check(same((value.auditGroups ?? []).flatMap(x => x.requirementIds), fixedIds), "group membership differs");
  const bundles = new Map((value.sourceBundles ?? []).map(x => [x.id, x]));
  check(bundles.size === 24, "source archive index missing");
  for (const bundle of value.sourceBundles ?? []) {
    check(/^output\/playwright\/liblib-tv-director\//.test(bundle.path) && !bundle.path.includes(".."), "unsafe archive path");
    check(/^[a-f0-9]{64}$/.test(bundle.sha256) && nonempty(bundle.coverage), bundle.id + " lacks digest/coverage");
    if (localEvidence) check(repoFile(bundle.path) && sha(bundle.path) === bundle.sha256, bundle.id + " archive changed/missing");
  }
  for (const group of groups.values()) {
    check([group.finding, group.implementationAction, group.sourceLimit].every(nonempty), group.id + " missing decision/boundary");
    check(group.codeRefs?.length > 0, group.id + " missing actual code");
    for (const ref of group.codeRefs ?? []) {
      check(repoFile(ref.path), group.id + " missing code path");
      if (repoFile(ref.path)) {
        check(sha(ref.path) === ref.sha256, ref.path + " changed; re-audit required");
        check(fs.readFileSync(path.join(root, ref.path), "utf8").split("\n")[ref.line - 1]?.includes(ref.needle), ref.path + " stale symbol/line");
      }
    }
    for (const test of group.supportingTests ?? []) {
      check(repoFile(test.path) && sha(test.path) === test.sha256, test.path + " stale test definition");
      check(test.executionStatus === "not_run_in_this_audit", test.path + " definition is not execution");
    }
  }
  for (const row of value.requirements ?? []) {
    const requirement = candidate.requirements.find(x => x.id === row.id);
    const group = groups.get(row.auditGroup);
    check(group?.requirementIds.includes(row.id), row.id + " lost audit group");
    check(docs.feature.split("\n")[row.contractLine - 1]?.startsWith("| " + row.id + " "), row.id + " stale contract row");
    check(row.source?.caseIds?.length > 0 && row.source.caseIds.every(id => bundles.has(id)), row.id + " missing archive provenance");
    check(row.source?.exhaustive === false && row.implementation?.notProductPass === true, row.id + " false completeness");
    check(same(row.plannedTests, requirement?.testIds ?? []) && same(row.fixtureIds, requirement?.fixtureIds ?? []), row.id + " planned tests/fixtures drift");
    check(same(row.deliveryStages, candidate.executionTracking.requirements.find(x => x.id === row.id)?.deliveryStages ?? []), row.id + " stage drift");
  }
  check(same(value.stageCases?.map(x => x.id), config.stages.filter(s => ["S1", "S2"].includes(s.id)).flatMap(s => s.requiredCases)), "S1/S2 cases missing");
  const cells = config.documentLifecycle.kinds.flatMap(k => config.documentLifecycle.operations.map(o => "LC-" + k + "-" + o));
  check(same(value.documentLifecycle?.map(x => x.id), cells), "35 lifecycle cells missing");
  check(same(value.visualCases?.map(x => x.state), config.visual.states), "visual states missing");
  for (const entry of [...(value.stageCases ?? []), ...(value.documentLifecycle ?? []), ...(value.visualCases ?? [])])
    check(safePlanPath(entry.plannedPath) && entry.executionStatus === "not_run", entry.id + " incomplete/fake runtime acceptance");
  check(same(value.sourceLimitDecisions?.map(x => x.id), candidate.differences.map(x => x.id)), "unknown decisions missing");
  for (const diff of value.sourceLimitDecisions ?? []) {
    const actual = candidate.differences.find(x => x.id === diff.id);
    check(diff.sourceParity === "not_claimed" && ["decision", "releaseGate", "owner"].every(k => nonempty(diff[k]) && diff[k] === actual?.[k]), diff.id + " unclosed/drifted decision");
  }
  const method = value.methodClosure;
  check(method?.sourceFilesRehashed === inventory.files.length && method?.sourceCopiesMatch === true &&
    method?.sourceRoutes === 15 && method?.methodContracts === 24 && method?.ruleContracts === 18 &&
    method?.packageCompletionNotClaimed === true, "short-drama source/method denominator changed");
  const e08 = candidate.requirements.find(r => r.id === "E08");
  check(["session.create", "draft.attachDocument", "message.send"].every(id => e08?.commands.includes(id)), "E08 live continuation chain omitted");
  return errors;
}

function checkDocuments() {
  const errors = [];
  const files = ["../tv-director-skill-fusion.md", "../liblib-tv-director-development.md",
    "feature-contracts.md", "skill-contracts.md", "workflow-contracts.md",
    "document-semantics.md", "acceptance-contracts.md", "implementation-closure.md",
    "full-replication-plan.md", "seed-outline-parity-implementation.md"];
  for (const file of files) {
    const full = path.resolve(directory, file), value = fs.readFileSync(full, "utf8");
    const fencePattern = new RegExp("^" + String.fromCharCode(96).repeat(3), "gm");
    if ((value.match(fencePattern) ?? []).length % 2) errors.push(file + ": unclosed fence");
    if (/[ \t]+$/m.test(value)) errors.push(file + ": trailing whitespace");
    for (const match of value.matchAll(/\[[^\]]+\]\(([^)\n]+)\)/g)) {
      const href = match[1].split("#")[0];
      if (!href || /^(https?:|mailto:)/.test(href)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(full), href))) errors.push(file + ": broken link " + href);
    }
    if (value.includes("/Users/") || /"(?:usertoken|access_token|refresh_token)"\s*:\s*"[^"]+"/.test(value))
      errors.push(file + ": potential credential/machine-path content");
  }
  return errors;
}

const errors = [...validate(map, inventory), ...validateParity(map, policy),
  ...validateClosure(closure, map, policy, process.argv.includes("--local-evidence")), ...checkDocuments()];
if (errors.length) {
  console.error(JSON.stringify({ kind: "specification", status: "FAIL", errors }, null, 2));
  process.exit(1);
}
let negativeCases = 0;
if (process.argv.includes("--self-test")) {
  const mutations = [
    ["missing button", m => m.requirements.splice(0, 1)],
    ["duplicate button", m => m.requirements.push(m.requirements[0])],
    ["dangling command", m => m.requirements[0].commands.push("unregistered")],
    ["wrong required parameter", m => m.commands[0].requiredFields.push("secretUnknownField")],
    ["missing input schema", m => m.schemas.splice(0, 1)],
    ["missing fixture", m => m.fixtures.pop()],
    ["missing transition", m => m.transitions.pop()],
    ["missing rule polarity", m => m.rules[0].testIds.pop()],
    ["missing method negative", m => m.methods[0].testIds.pop()],
    ["fake product pass", m => { m.requirements[0].status = "pass"; m.requirements[0].resultRef = null; }],
    ["fake test pass", m => { m.tests[0].executionStatus = "pass"; m.tests[0].resultRef = null; }],
    ["unsafe planned path", m => m.requirements[0].componentPath = "/tmp/anything.tsx"],
    ["wrong denominator", m => m.counts.actions = 148],
    ["unresolved difference", m => m.differences[0].designStatus = "later"],
    ["orphan use case", m => m.requirements[0].useCasePaths = []],
    ["missing source route", m => m.sourceRoutes.pop()],
    ["invented source hash", (_m, s) => s.files[0].sha256 = "invented"],
    ["invented knowledge", (_m, s) => s.knowledge.ruleCount = 100],
    ["input source drift", (_m, s) => s.files[0].originMatch = false],
    ["unversioned endpoint", m => m.transports.find(t => t.method !== "local").route = "/legacy"],
    ["permissive schema", m => m.schemas[0].additionalProperties = true],
    ["weakened quality sample", m => m.qualityGroups[0].runsPerSide = 1],
    ["workflow guard drift", m => m.transitions.find(x => x.id === "WT06").guard = "generate everything"],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(map), source = structuredClone(inventory);
    mutate(candidate, source);
    if (!validate(candidate, source).length) throw new Error("Self-test escaped: " + name);
    negativeCases++;
  }
  const parityMutations = [
    ["missing current button", m => m.executionTracking.requirements.pop()],
    ["missing partial acceptance", (_m, p) => p.stages[1].requiredCases = p.stages[1].requiredCases.filter(x => x !== "S1-04")],
    ["missing original gate", (_m, p) => p.stages[2].requiredCases.pop()],
    ["cycle in stages", (_m, p) => p.stages[1].dependsOn.push("S10")],
    ["unknown new phase", m => m.executionTracking.requirements[0].deliveryStages.push("S99")],
    ["fake implementation acceptance", m => m.executionTracking.requirements[0].implementation.auditStatus = "validated"],
    ["fake source observation", m => { m.executionTracking.requirements[0].sourceEvidence.status = "observed"; m.executionTracking.requirements[0].sourceEvidence.caseBindings = []; }],
    ["lost dirty baseline", m => m.baseline.dirtySnapshotFiles = []],
    ["silent model switch", (_m, p) => p.modelPolicy.allowSilentFallback = true],
    ["parallel model test", (_m, p) => p.modelPolicy.allowDefaultMultiModelComparison = true],
    ["mask into pass", (_m, p) => p.visual.allowMaskResizeBlurOrAlignmentForPass = true],
    ["missing save failure state", (_m, p) => p.visual.states = p.visual.states.filter(x => x !== "save_failed")],
    ["literary scale drift", (_m, p) => p.literary.scale[0] = 0],
    ["four probes replace full set", (_m, p) => p.literary.fullSamplesPerSide = 4],
    ["invented independent judging", (_m, p) => p.literary.independentReviewersForFullGate = 1],
    ["shared version for five documents", (_m, p) => p.documentLifecycle.sameDocumentAcrossSurfacesNotSameVersionAcrossDocuments = false],
    ["missing downstream lifecycle", (_m, p) => p.documentLifecycle.operations.pop()],
  ];
  for (const [name, mutate] of parityMutations) {
    const candidate = structuredClone(map), config = structuredClone(policy);
    mutate(candidate, config);
    if (!validateParity(candidate, config).length) throw new Error("Self-test escaped: " + name);
    negativeCases++;
  }
  const closureMutations = [
    ["missing audited button", c => c.requirements.pop()],
    ["wrong code line", c => c.auditGroups[0].codeRefs[0].line = 1],
    ["wrong code hash", c => c.auditGroups[0].codeRefs[0].sha256 = "0".repeat(64)],
    ["false source completeness", c => c.claimBoundary.allSourceStatesProven = true],
    ["false recovered skill", c => c.claimBoundary.hiddenSourceSkillsRecovered = true],
    ["false test execution", c => c.auditGroups[0].supportingTests[0].executionStatus = "pass"],
    ["missing source provenance", c => c.requirements[0].source.caseIds = []],
    ["missing stage case", c => c.stageCases.pop()],
    ["missing document lifecycle", c => c.documentLifecycle.pop()],
    ["missing visual state", c => c.visualCases.pop()],
    ["unknown without decision", c => c.sourceLimitDecisions[0].decision = ""],
    ["source method dropped", c => c.methodClosure.methodContracts = 23],
  ];
  for (const [name, mutate] of closureMutations) {
    const value = structuredClone(closure);
    mutate(value);
    if (!validateClosure(value, map, policy).length) throw new Error("Self-test escaped: " + name);
    negativeCases++;
  }
}
console.log(JSON.stringify({
  kind: "specification_only", status: "PASS", counts: map.counts,
  commands: map.commands.length, plannedTests: map.tests.length,
  sourceFiles: inventory.files.length, negativeMutationsRejected: negativeCases,
  currentRequirementsTracked: map.executionTracking.requirements.length,
  auditedGroups: closure.auditGroups.length, sourceArchivesIndexed: closure.sourceBundles.length,
  lifecycleCells: closure.documentLifecycle.length, visualStates: closure.visualCases.length,
  localEvidenceHashesChecked: process.argv.includes("--local-evidence"),
  policyId: policy.policyId, productStageStatus: policy.productAcceptanceStatus,
  productTestsExecuted: 0, providerCalls: 0,
  note: "索引和文档检查通过，不代表482个计划用例或产品功能通过。"
}, null, 2));
