export type Assertion = {
  name: string;
  pass: boolean;
  detail?: string;
};

export type AssertionResult = {
  key: string;
  score: number;
  comment: string;
  passed: boolean;
  assertions: Assertion[];
};

export function scoreAssertions(key: string, assertions: Assertion[]): AssertionResult {
  const total = assertions.length;
  const passedCount = assertions.filter((a) => a.pass).length;
  const score = total === 0 ? 0 : passedCount / total;
  const failed = assertions.filter((a) => !a.pass);
  const comment =
    failed.length === 0
      ? `All ${total} assertions passed.`
      : `Failed ${failed.length}/${total}: ` +
        failed.map((a) => `${a.name}${a.detail ? ` (${a.detail})` : ""}`).join("; ");

  return {
    key,
    score,
    comment,
    passed: passedCount === total,
    assertions,
  };
}
