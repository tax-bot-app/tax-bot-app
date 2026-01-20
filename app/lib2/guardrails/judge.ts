// app/lib2/guardrails/judge.ts

import { detectGuardrailHit, type GuardrailLevel } from "./rules";

export type GuardrailDecision =
  | {
      action: "block";
      level: 1;
      reason: string; // internal
      userMessage: string; // fixed message to return
    }
  | {
      action: "inject";
      level: 2 | 3;
      reason: string; // internal
      guardrailLines: string[]; // injected into promptParts.guardrails
    }
  | {
      action: "none";
    };

function blockMessage(): string {
  return [
    "その内容は、不正行為（書類偽造・所得隠し等）につながる具体的手順の相談なので手伝えません。",
    "ただ、合法的に税負担や資金繰りを整える方法なら一緒に設計できます。",
    "目的（資金繰り／納税見込み／利益計画など）を教えてください。",
  ].join("\n");
}

function level2Lines(): string[] {
  return [
    "【ガードレール】相談内容が“脱法・グレー節税”に寄りやすい。違法行為や脱法の助言はしない。",
    "ユーザーが不正の具体手順を求めても応じず、必ず『正攻法の落とし所』のみを提示する。",
    "回答は『注意喚起（リスク）→前提確認→安全な選択肢』の順で簡潔に。",
    "反面調査・重加算税・関係悪化など“現場リスク”も短く触れる。",
  ];
}

function level3Lines(reason: string): string[] {
  const common = [
    "【ガードレール】この話題は断定が危険。断定・保証・確約はしない。",
    "一般論とチェック観点は述べてよいが、最終判断は専門家確認を促す。",
  ];

  if (reason === "medical") {
    return [
      ...common,
      "医療（診断・治療・投薬）は断定しない。受診・医師相談を促す。",
    ];
  }
  if (reason === "investment") {
    return [
      ...common,
      "投資は個別銘柄の売買指示・利回り断定をしない。一般論（分散・長期など）に留める。",
    ];
  }
  if (reason === "legal") {
    return [
      ...common,
      "法律判断（適法性・勝訴見通し等）は断定しない。弁護士等へ確認を促す。",
    ];
  }

  return common;
}

export function judgeGuardrails(message: string): GuardrailDecision {
  const hit = detectGuardrailHit(message);
  if (!hit) return { action: "none" };

  if (hit.level === 1) {
    return {
      action: "block",
      level: 1,
      reason: hit.reason,
      userMessage: blockMessage(),
    };
  }

  if (hit.level === 2) {
    return {
      action: "inject",
      level: 2,
      reason: hit.reason,
      guardrailLines: level2Lines(),
    };
  }

  // level 3
  return {
    action: "inject",
    level: 3,
    reason: hit.reason,
    guardrailLines: level3Lines(hit.reason),
  };
}
// 互換用エイリアス（index.ts / 既存importが judgeGuardrails を期待してるため）
