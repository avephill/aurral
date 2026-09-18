import { deleteData, getData, patchData, postData, putData } from "../core.js";

// Congregations: who you share with. Everything you send reaches everyone in
// every congregation you are in, and nobody else.

export const getCongregations = (options = {}) => getData("/congregations", options);

export const joinCongregation = (id) => postData(`/congregations/${encodeURIComponent(id)}/join`, {});

export const leaveCongregation = (id) => postData(`/congregations/${encodeURIComponent(id)}/leave`, {});

// Admin only.
export const createCongregation = (body) => postData("/congregations", body);
export const updateCongregation = (id, body) => patchData(`/congregations/${encodeURIComponent(id)}`, body);
export const setCongregationMembers = (id, members) =>
  putData(`/congregations/${encodeURIComponent(id)}/members`, { members });
export const removeCongregation = (id) => deleteData(`/congregations/${encodeURIComponent(id)}`);
