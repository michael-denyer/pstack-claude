// Run under the Node runtime that can read your DSH installation:
// node tests/dsh-smoke.mjs /absolute/path/to/dsh/node_modules
// This uses real Cordis, dsh-skill and dsh-skill-filesystem, not test doubles.
// It mounts an isolated context; no user profile, model, or auth files are read.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.argv.length, 3, "Pass the absolute node_modules directory of an installed DSH runtime");
assert(isAbsolute(process.argv[2]), "DSH node_modules must be an absolute path");
const modules = process.argv[2];
const load = name => import(pathToFileURL(join(modules, "@deepseek-ai", name, "lib/index.js")).href);
const [{ Context }, { default: SkillRegistry, isModelInvocable }, filesystem] = await Promise.all([
  load("cordis"), load("dsh-skill"), load("dsh-skill-filesystem"),
]);
const dshManifest = JSON.parse(await readFile(join(modules, "@deepseek-ai/dsh/package.json"), "utf8"));
const repo = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = join(repo, "plugins/pstack/skills");
const names = (await readdir(skillRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
assert(names.includes("poteto-mode") && names.includes("principle-prove-it-works"));
const directory = await mkdtemp(join(tmpdir(), "pstack-dsh-smoke-"));
const results = [];
const contexts = [];
try {
  const project = join(directory, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, ".agents/skills"), { recursive: true });
  for (const name of names) {
    await symlink(join(skillRoot, name), join(project, ".agents/skills", name), process.platform === "win32" ? "junction" : "dir");
  }
  for (const source of ["custom", "project-links"]) {
    const ctx = new Context();
    contexts.push(ctx);
    await ctx.plugin(SkillRegistry);
    const provider = await ctx.plugin(filesystem, {
      providerName: `pstack-smoke-${source}`,
      includeDefaultRoots: source === "project-links",
      customSkillDirs: source === "custom" ? [skillRoot] : [],
      dshHome: join(directory, "empty-dsh-home"),
      agentsHome: join(directory, "empty-agents-home"),
      bundledSkillDir: join(directory, "empty-bundled-root"),
      watch: false,
    });
    const options = { cwd: project };
    const snapshot = await ctx.skills.snapshot(options);
    assert.equal(snapshot.complete, true, `${source}: discovery must be complete`);
    assert.deepEqual(snapshot.skills.filter(isModelInvocable).map(skill => skill.name).sort(), names);
    for (const name of ["poteto-mode", "principle-prove-it-works", "setup-pstack"]) {
      const skill = await ctx.skills.get(name, options);
      assert(skill && isModelInvocable(skill), `${source}: ${name} must load for the model`);
      assert.equal(await realpath(skill.path), await realpath(join(skillRoot, name, "SKILL.md")));
      assert.equal(skill.resourceBase.kind, "directory");
      assert.equal(await realpath(skill.resourceBase.path), await realpath(join(skillRoot, name)));
      assert(skill.content.length > 0);
      if (name === "poteto-mode") {
        assert(skill.content.includes("references/dsh-tools.md"), "Generated routing must point at the DSH mapping");
        const mapping = await readFile(join(skill.resourceBase.path, "references/dsh-tools.md"), "utf8");
        assert(mapping.includes("list_subagent_models") && mapping.includes("subagent"));
      }
    }
    const principle = snapshot.skills.find(skill => skill.name === "principle-prove-it-works");
    assert.equal(principle.invocation.modelInvocable, true);
    assert.equal(principle.invocation.userInvocable, false);
    await provider.dispose();
    assert.deepEqual((await ctx.skills.snapshot(options)).skills, [], "Disposal must unregister the skill source");
    results.push({ source, modelSkills: names.length, fullBodies: ["poteto-mode", "principle-prove-it-works", "setup-pstack"], disposed: true });
  }
  console.log(JSON.stringify({ dsh: dshManifest.version, node: process.version, results,
    limitations: ["Does not start a model request or test model compliance", "Does not install a native DSH plugin, routing hook, role sheet, or scheduler", "Uses the installed runtime's real registry/provider in an isolated context, not the user's live profile"] }, null, 2));
} finally {
  await Promise.all(contexts.map(ctx => ctx.fiber.dispose()));
  assert(isAbsolute(directory) && basename(directory).startsWith("pstack-dsh-smoke-"));
  await rm(directory, { recursive: true, force: true });
}
