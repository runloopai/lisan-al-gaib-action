declare module "spdx-satisfies" {
  function spdxSatisfies(
    candidate: string,
    approved: string[],
  ): boolean;
  export default spdxSatisfies;
}

declare module "spdx-correct" {
  function spdxCorrect(identifier: string): string | null;
  export default spdxCorrect;
}
