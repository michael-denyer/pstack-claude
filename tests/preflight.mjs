// Names the fix when the copy of Pi in plugins/ that the Pi tests load is not
// installed. Without it those tests fail with only "Cannot find module". This
// does not stop the run: a run that never loads Pi, such as the Windows session
// hooks job, which installs only the root dependencies, still passes. The
// note prints first and again after the last test, below the errors.
import { afterAll } from "bun:test";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL("../plugins/pstack/pi/", import.meta.url));

function piInstalled() {
  try {
    Bun.resolveSync("@earendil-works/pi-coding-agent", extensionDir);
    return true;
  } catch {
    return false;
  }
}

// Nested `bun test` runs some tests spawn inherit the variable and stay quiet.
if (!process.env.PSTACK_PI_NOTE_SHOWN && !piInstalled()) {
  process.env.PSTACK_PI_NOTE_SHOWN = "1";
  const note =
    'The copy of Pi in plugins/ is not installed, so tests that load the Pi extension fail with "Cannot find module". Run:\n  bun install --frozen-lockfile --cwd plugins\n(see CONTRIBUTING.md, "Before you open a PR")';
  console.error(note);
  afterAll(() => console.error(`\n${note}`));
}
