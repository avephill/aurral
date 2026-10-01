import { deleteData, getData, patchData, postData } from "../core.js";

// Ideas and problems sent from the app, and what comes back.

export const getFeedbackWaiting = ({ signal } = {}) => getData("/feedback/waiting", { signal });

export const getMyFeedback = ({ signal } = {}) => getData("/feedback/mine", { signal });

export const sendFeedback = ({ kind, message, page }) => postData("/feedback", { kind, message, page });

export const markFeedbackRepliesRead = () => postData("/feedback/mine/read", {});

export const getAllFeedback = ({ signal } = {}) => getData("/feedback", { signal });

export const answerFeedback = (id, { status, reply }) =>
  patchData(`/feedback/${encodeURIComponent(id)}`, { status, reply });

export const deleteFeedback = (id) => deleteData(`/feedback/${encodeURIComponent(id)}`);
