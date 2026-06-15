export type KappaResult = {
  n: number;
  observedAgreement: number;
  expectedAgreement: number;
  humanPassRate: number;
  judgePassRate: number;
  // null when raters are in perfect or unanimous agreement on one class
  // (denominator 1 - p_e is 0). Caller decides how to display.
  kappa: number | null;
};

export function cohensKappa(pairs: Array<[boolean, boolean]>): KappaResult {
  const n = pairs.length;
  if (n === 0) {
    return {
      n: 0,
      observedAgreement: 0,
      expectedAgreement: 0,
      humanPassRate: 0,
      judgePassRate: 0,
      kappa: null,
    };
  }

  let agree = 0;
  let humanPass = 0;
  let judgePass = 0;
  for (const [human, judge] of pairs) {
    if (human === judge) agree += 1;
    if (human) humanPass += 1;
    if (judge) judgePass += 1;
  }

  const observedAgreement = agree / n;
  const humanPassRate = humanPass / n;
  const judgePassRate = judgePass / n;
  const expectedAgreement =
    humanPassRate * judgePassRate + (1 - humanPassRate) * (1 - judgePassRate);

  const denom = 1 - expectedAgreement;
  const kappa = denom === 0 ? null : (observedAgreement - expectedAgreement) / denom;

  return { n, observedAgreement, expectedAgreement, humanPassRate, judgePassRate, kappa };
}

export function kappaVerdict(kappa: number | null, threshold = 0.7): "SHIP" | "REFINE" | "N/A" {
  if (kappa === null) return "N/A";
  return kappa >= threshold ? "SHIP" : "REFINE";
}
