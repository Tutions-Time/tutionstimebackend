const axios = require('axios');

// Base URL for API
const API_URL = 'http://localhost:5000/api';

// Test authentication endpoint
const testAuth = async () => {
  try {
    console.log('\n===== Testing Auth: Send OTP =====');
    const response = await axios.post(`${API_URL}/auth/send-otp`, {
      phone: '9876543210',
      purpose: 'signup'
    });
    
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return response.data.requestId;
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
};

// Run test
testAuth().then(requestId => {
  console.log('\nTest completed. RequestId:', requestId);
});