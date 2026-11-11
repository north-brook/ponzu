import { ClaudeCard, type ClaudeCardProps, canConnect } from "./claude-card.tsx";
import { StepButton, StepLayout } from "./step.tsx";

/**
 * Connect Claude: required, since Claude Code does the designing. Choosing a way turns the card
 * into its entry, and Connect appears below it; while choosing, each row has its own button.
 */
export function ClaudeStep(props: ClaudeCardProps) {
  const { state } = props;
  return (
    <StepLayout
      progress={2}
      title="Connect Claude"
      body="Claude Code does the designing, in the cloud, on your own plan. It picks up where you left off on any device."
      actions={
        state.mode === "choose" ? null : (
          <StepButton
            onClick={props.onSubmit}
            disabled={!canConnect(state)}
            busy={state.status === "connecting"}
          >
            Connect
          </StepButton>
        )
      }
    >
      <ClaudeCard {...props} />
    </StepLayout>
  );
}
