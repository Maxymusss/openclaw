import path from "node:path";
import stylelint from "stylelint";
import { createIconGridAuditor } from "./control-ui-icon-grid-fit.mts";

const ruleName = "openclaw/icon-grid-fit";
const messages = stylelint.utils.ruleMessages(ruleName, { rejected: (detail: string) => detail });
const auditors = new Map<string, ReturnType<typeof createIconGridAuditor>>();

const rule: stylelint.Rule = (primary) => (root, result) => {
  if (!stylelint.utils.validateOptions(result, ruleName, { actual: primary, possible: [true] })) {
    return;
  }
  const file = root.source?.input.file;
  if (!file?.endsWith(".css")) {
    return;
  }
  const uiSegment = file.lastIndexOf(path.sep + "ui" + path.sep);
  if (uiSegment < 0) {
    return;
  }
  const rootDir = file.slice(0, uiSegment);
  let audit = auditors.get(rootDir);
  if (!audit) {
    audit = createIconGridAuditor(rootDir);
    auditors.set(rootDir, audit);
  }
  const { findings } = audit(root.toString(), file);
  for (const finding of findings) {
    const node =
      root.nodes.find(
        (candidate) => candidate.type === "rule" && candidate.selectors.includes(finding.selector),
      ) ?? root;
    const source = finding.file + ":" + finding.line;
    const message =
      finding.kind === "native-padding"
        ? 'Set explicit padding for fixed-size icon grid "' +
          finding.control +
          '"; native button padding can shift its icon (' +
          source +
          ")"
        : "Icon " +
          finding.axis +
          " " +
          finding.icon +
          "px exceeds the " +
          finding.available +
          'px content space of "' +
          finding.control +
          '" (' +
          finding.size +
          "px - " +
          finding.padding +
          "px padding - " +
          finding.border +
          "px border; " +
          source +
          ")";
    stylelint.utils.report({
      ruleName,
      result,
      node,
      message: messages.rejected(message),
      word: finding.selector,
    });
  }
};
rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = {
  url: "https://github.com/openclaw/openclaw/blob/main/ui/AGENTS.md#css--template-linting",
};
export default stylelint.createPlugin(ruleName, rule);
