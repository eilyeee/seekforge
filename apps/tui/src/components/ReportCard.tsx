import React from "react";
import { Box, Text } from "ink";
import type { FinalReport } from "@seekforge/shared";
import { formatUsage } from "../format.js";
import { Markdown } from "./Markdown.js";
import { ACCENT } from "./Header.js";

export function ReportCard({ report }: { report: FinalReport }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginY={1}>
      <Text color={ACCENT} bold>
        Report
      </Text>
      <Markdown text={report.summary} />
      {report.changedFiles.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>changed files</Text>
          {report.changedFiles.map((f, i) => (
            <Text key={i}>
              <Text color="yellow">● </Text>
              {f}
            </Text>
          ))}
        </Box>
      ) : null}
      {report.verification ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>verification</Text>
          <Text>{report.verification}</Text>
        </Box>
      ) : null}
      <Text dimColor>{formatUsage(report.usage)}</Text>
    </Box>
  );
}
