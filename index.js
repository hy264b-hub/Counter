function getActiveSourceStrict() {
  const c = getCtx();

  // ✅ "현재 선택"에 가장 가까운 키들을 최우선으로 본다
  const candidates = [
    c?.settings?.main_api,
    c?.main_api,
    c?.settings?.chat_completion_source,
    c?.chat_completion_source,
    c?.settings?.api_source,
    c?.api_source,
  ].filter(v => typeof v === "string" && v.trim());

  if (candidates.length) return candidates[0].toLowerCase().trim();

  return ""; // 못 찾으면 빈 문자열
}

function getOpenAIEndpointStrict() {
  const c = getCtx();

  // ✅ openai-compatible 쪽 endpoint로 "보이는" 키만 본다 (google쪽 설정과 섞지 않음)
  const candidates = [
    c?.openai_settings?.base_url,
    c?.openai_settings?.api_url,
    c?.oai_settings?.base_url,
    c?.oai_settings?.api_url,
    c?.settings?.api_url,
    c?.settings?.base_url,
    c?.api_url,
    c?.base_url,
  ].filter(v => typeof v === "string" && v.trim());

  if (candidates.length) return candidates[0].toLowerCase().trim();

  return "";
}

function is4141Endpoint(endpoint) {
  const ep = (endpoint || "").toLowerCase();
  return (
    ep.includes("localhost:4141") ||
    ep.includes("127.0.0.1:4141") ||
    ep.includes("0.0.0.0:4141") ||
    ep.includes(":4141/")
  );
}
