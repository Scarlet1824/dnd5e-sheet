import { API_BASE_URL } from "./config.js";

const TOKEN_KEY = "dnd5e_token";
const USER_KEY = "dnd5e_user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}
export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
export function isConfigured() {
  return !API_BASE_URL.includes("YOUR-SUBDOMAIN");
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  if (!isConfigured()) {
    const err = new Error("API_NOT_CONFIGURED");
    err.code = "API_NOT_CONFIGURED";
    throw err;
  }
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error("Не удалось связаться с сервером. Проверьте адрес API и подключение.");
    err.code = "NETWORK_ERROR";
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    if (res.status === 401) clearSession();
    const err = new Error((data && data.error) || `Ошибка запроса (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  register: (email, password) => request("/api/register", { method: "POST", body: { email, password }, auth: false }),
  login: (email, password) => request("/api/login", { method: "POST", body: { email, password }, auth: false }),
  logout: () => request("/api/logout", { method: "POST" }),
  me: () => request("/api/me"),
  listCharacters: () => request("/api/characters"),
  createCharacter: (payload) => request("/api/characters", { method: "POST", body: payload }),
  getCharacter: (id) => request(`/api/characters/${id}`),
  updateCharacter: (id, payload) => request(`/api/characters/${id}`, { method: "PUT", body: payload }),
  deleteCharacter: (id) => request(`/api/characters/${id}`, { method: "DELETE" }),
  // кампании
  listCampaigns: () => request("/api/campaigns"),
  createCampaign: (name) => request("/api/campaigns", { method: "POST", body: { name } }),
  joinCampaign: (code) => request("/api/campaigns/join", { method: "POST", body: { code } }),
  getCampaign: (id) => request(`/api/campaigns/${id}`),
  updateCampaign: (id, body) => request(`/api/campaigns/${id}`, { method: "PUT", body }),
  deleteCampaign: (id) => request(`/api/campaigns/${id}`, { method: "DELETE" }),
  setMyCharacter: (id, characterId) => request(`/api/campaigns/${id}/character`, { method: "PUT", body: { characterId } }),
  leaveCampaign: (id) => request(`/api/campaigns/${id}/membership`, { method: "DELETE" }),
  kickMember: (id, userId) => request(`/api/campaigns/${id}/members/${userId}`, { method: "DELETE" }),
  sendRoll: (id, body) => request(`/api/campaigns/${id}/roll`, { method: "POST", body }),
};
