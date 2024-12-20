require('dotenv').config();  // Only call it once at the top
const pool = require('./db');
const express = require('express');
const cors = require('cors');

const corsOptions = {
    origin: ["http://localhost:5173"],
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.get("/api", (req, res) => {
    res.json({plantTest: ["fern", "flower", "weed"]});
});

//OAuth Log in 
app.post('/login', async (req, res) => {
    console.log(req.body);
    const { token } = req.body; 
    if (!token) {
      return res.status(400).send('Token is required');
    }
    try {
      // Verify the token
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID, 
      });
      const payload = ticket.getPayload();
      const { sub: googleId, name, email } = payload;

      // Check if the user already exists
      const findUserQuery = 'SELECT * FROM users WHERE userId = $1';
      const userResult = await pool.query(findUserQuery, [googleId]);
      if (userResult.rows.length === 0) {
          // Insert the new user if they don't exist
          const insertUserQuery = `
              INSERT INTO users (userId, name, email)
              VALUES ($1, $2, $3)
              RETURNING userId, paid`;
          const newUser = await pool.query(insertUserQuery, [googleId, name, email]);
          //console.log('New user added:', newUser.rows[0]);
          console.log(payload); 
          res.status(200).send({ message: 'User authenticated', user: newUser.rows[0] });
      } else {
          //console.log('User already exists:', userResult.rows[0]);
          console.log(payload); 
          res.status(200).send({ message: 'User authenticated', user: userResult.rows[0] });
      }
      
    } catch (error) {
      console.error('Error verifying token:', error);
      res.status(400).send('Invalid token');
    }
});

  //Add new plant to garden
  app.post('/plants', async (req, res) => {
    console.log('Request Body:', req.body);
    const {userId, common_name, water_frequency = Math.floor(Math.random() * 3) + 1} = req.body;
    // Validate required fields
    if (!userId) {
      return res.status(400).send('Missing required field: userId');
    }
    if (!common_name) {
      return res.status(400).send('Missing required field: common_name');
    }
    try {
      // Attempt to insert the plant and return the plantId
      const insertPlantQuery = `
        INSERT INTO plants (common_name, water_frequency)
        VALUES ($1, $2)
        ON CONFLICT (common_name) DO NOTHING
        RETURNING plantId
      `;
      const plantResult = await pool.query(insertPlantQuery, [
        common_name, water_frequency
      ]);

      let plantId;

      if (plantResult.rows.length === 0) {
        // If no rows were inserted, fetch the existing plantId
        const fetchPlantQuery = 'SELECT plantId FROM plants WHERE common_name = $1';
        const fetchResult = await pool.query(fetchPlantQuery, [common_name]);
        plantId = fetchResult.rows[0].plantid;
      } else {
        // If the plant was inserted, retrieve the returned plantId
        plantId = plantResult.rows[0].plantid;
      }

      // Insert into the garden table
      const insertGardenQuery = `
        INSERT INTO garden (userId, plantId, water_done, plant_health)
        VALUES ($1, $2, $3, $4)
      `;
      await pool.query(insertGardenQuery, [userId, plantId, 0, 'Bad :(']);

      res.status(201).send({ message: 'Plant added successfully', plantId });
    } catch (error) {
      console.error('Error adding plant to the garden:', error);
      res.status(500).send('Server error: Could not add plant');
    }
  });

  // Retrieve the whole garden
  app.get('/plants', async (req, res) => {
    try {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ message: 'Missing required parameter: userId' });
      }

      // Query the database for plants in the user's garden
      const gardenQuery = `
        SELECT g.water_done, g.plant_health, 
              p.plantId, p.common_name, p.water_frequency
        FROM garden g
        INNER JOIN plants p ON g.plantId = p.plantId
        WHERE g.userId = $1
      `;
      const gardenResult = await pool.query(gardenQuery, [userId]);

      if (gardenResult.rows.length === 0) {
        return res.status(404).json({ message: 'No plants found for the given user' });
      }

      // Send the fetched plants as a response
      res.status(200).json({
        message: 'Plants fetched successfully',
        plants: gardenResult.rows
      });
    } catch (error) {
      console.error('Error fetching plants:', error);
      res.status(500).json({ message: 'Server error, could not fetch plants' });
    }
  });

  // Delete a plant from the garden
  app.delete('/plants/:plantId', async (req, res) => {
    try {
      const { plantId } = req.params;

      if (!plantId) {
        return res.status(400).json({ message: 'Missing required parameter: plantId' });
      }

      // Delete the plant from the garden table
      const deleteFromGardenQuery = `
        DELETE FROM garden 
        WHERE plantId = $1
      `;
      const gardenResult = await pool.query(deleteFromGardenQuery, [plantId]);

      if (gardenResult.rowCount === 0) {
        return res.status(404).json({ message: 'Plant not found in the garden' });
      }

      res.status(200).json({ message: 'Plant deleted successfully' });
    } catch (error) {
      console.error('Error deleting plant:', error);
      res.status(500).json({ message: 'Server error, could not delete plant' });
    }
  });

// Water the plant
app.put('/plants/water', async (req, res) => {
  const { plantId } = req.body;

  if (!plantId) {
    return res.status(400).json({ message: 'Valid Plant ID is required' });
  }

  try {
    // Update water_done in the garden table
    const updateQuery = `
      UPDATE garden 
      SET water_done = water_done + 1 
      WHERE plantId = $1 
      RETURNING *;
    `;
    const gardenResult = await pool.query(updateQuery, [plantId]);

    if (gardenResult.rowCount === 0) {
      return res.status(404).json({ message: 'No plant found with the given ID' });
    }

    const updatedPlant = gardenResult.rows[0];

    // Get the water_frequency from the plants table
    const plantQuery = `
      SELECT common_name, water_frequency 
      FROM plants 
      WHERE plantId = $1;
    `;
    const plantResult = await pool.query(plantQuery, [plantId]);

    if (plantResult.rowCount === 0) {
      return res.status(404).json({ message: 'No plant found with the given ID in the plants table' });
    }

    const waterFrequency = plantResult.rows[0].water_frequency;

    // Update plant_health in the garden table to "Good"
    const healthUpdateQuery = `
      UPDATE garden
      SET plant_health = 'Good :)'
      WHERE plantId = $1 
      RETURNING *;
    `;
    const healthResult = await pool.query(healthUpdateQuery, [plantId]);

    if (healthResult.rowCount === 0) {
      return res.status(500).json({ message: 'Failed to update plant health' });
    }
    const { common_name, water_frequency } = plantResult.rows[0];
    res.status(200).json({
      message: `Plant ${plantId} has been watered`,
      plant: {
        ...updatedPlant,
        common_name,
        water_frequency,
        plant_health: healthResult.rows[0].plant_health, // Include updated health in the response
      },
    });
  } catch (error) {
    console.error('Error watering plant:', error);
    res.status(500).send('Server error, could not water plant');
  }
});


    

// Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
