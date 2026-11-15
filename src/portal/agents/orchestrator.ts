import { BuilderAgent, type BuilderDraft, type BuilderPromptContext } from "./builder.js";
import { ComponentValidator, type ValidationReport } from "./validator.js";

// AgentOrchestrator — Coordinates two-agent consensus between Builder and Validator (KTD5, R13, R14, AE2).

export interface OrchestrationResult {
  status: "approved" | "rejected_with_alternatives";
  explanation: string;
  code?: string;
  target?: "policy" | "interaction";
  validation: ValidationReport;
  suggestedAlternative?: string;
}

export class AgentOrchestrator {
  private readonly builder: BuilderAgent;
  private readonly validator: ComponentValidator;

  constructor(builder = new BuilderAgent(), validator = new ComponentValidator()) {
    this.builder = builder;
    this.validator = validator;
  }

  async processRequest(
    userPrompt: string,
    options: {
      currentCode?: string;
      mode?: "blank_slate" | "customize_stock";
    } = {}
  ): Promise<OrchestrationResult> {
    const mode = options.mode ?? "customize_stock";

    // 1. First draft from BuilderAgent
    let draft = await this.builder.generatePeriphery({
      userPrompt,
      currentCode: options.currentCode,
      mode
    });

    // 2. Validate draft code with ComponentValidator
    let validation = this.validator.validateCode(draft.code);

    // 3. If validation failed, reprompt builder with validation feedback
    if (!validation.valid) {
      draft = await this.builder.generatePeriphery({
        userPrompt,
        currentCode: options.currentCode,
        mode,
        validationFeedback: validation
      });
      // Re-validate revised code
      validation = this.validator.validateCode(draft.code);
    }

    // 4. If builder identified an unsupported capability (e.g. rotator per AE2)
    if (draft.suggestedAlternative) {
      return {
        status: "rejected_with_alternatives",
        explanation: draft.explanation,
        code: validation.valid ? draft.code : undefined,
        target: draft.target,
        validation,
        suggestedAlternative: draft.suggestedAlternative
      };
    }

    if (!validation.valid) {
      return {
        status: "rejected_with_alternatives",
        explanation: draft.explanation,
        validation,
        suggestedAlternative: validation.errors[0]?.alternative
      };
    }

    return {
      status: "approved",
      explanation: draft.explanation,
      code: draft.code,
      target: draft.target,
      validation
    };
  }
}
