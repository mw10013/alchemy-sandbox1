import * as Schema from "effect/Schema";
import { TestFileStage } from "../../src/backend/stage.ts";

const encodeTestFileStage = Schema.encodeSync(TestFileStage);
const decodeTestFileStage = Schema.decodeUnknownSync(TestFileStage);

/**
 * An integ file's own stage, the checkout's `test` stage (`ALCHEMY_TEST_STAGE`) with `name`
 * appended, as {@link TestFileStage} spells it. Pass it to `Test.make`'s `stage`: a file without
 * it deploys on the harness's default stage, which another file without it shares, and the two
 * destroy each other's stack when the files run in parallel. `name` is the file's name without
 * its dashes (`shopactor` for `shop-actor.test.ts`).
 */
export const fileStage = (name: string) =>
  encodeTestFileStage(decodeTestFileStage(`${process.env.ALCHEMY_TEST_STAGE}-${name}`));
