// services/zoomService.js
const axios = require('axios');

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

/**
 * 🔑 Get a short-lived Zoom OAuth access token
 * Uses Server-to-Server OAuth flow
 */
async function getZoomAccessToken() {
  try {
    const response = await axios.post(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
      {},
      {
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64'),
        },
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error('❌ Error fetching Zoom access token:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Zoom API');
  }
}

/**
 * 🧭 Create a Zoom meeting
 * @param {Object} options
 * @param {string} options.topic - Meeting topic/title
 * @param {string} options.startTime - ISO date string
 * @param {number} [options.duration=60] - Duration in minutes
 * @returns {Promise<Object>} - Zoom meeting data (join_url, start_url, id, password)
 */
async function createZoomMeeting({ topic, startTime, duration = 60 }) {
  try {
    const token = await getZoomAccessToken();

    const response = await axios.post(
      `https://api.zoom.us/v2/users/me/meetings`,
      {
        topic,
        type: 2, // Scheduled meeting
        start_time: startTime,
        duration,
        timezone: 'Asia/Kolkata',
        settings: {
          join_before_host: true,
          approval_type: 2,
          registration_type: 1,
          waiting_room: false,
          mute_upon_entry: true,
          participant_video: true,
          host_video: true,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✅ Zoom meeting created: ${response.data.join_url}`);
    return response.data;
  } catch (error) {
    console.error('❌ Error creating Zoom meeting:', error.response?.data || error.message);
    throw new Error('Failed to create Zoom meeting');
  }
}

module.exports = { createZoomMeeting };
