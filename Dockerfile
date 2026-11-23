# Use an official Python runtime as a parent image
# Explicitly use 3.12 to avoid audioop removal in 3.13
FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /app

# Copy the current directory contents into the container at /app
COPY . /app

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Create necessary directories and setup assets
RUN mkdir -p app/temp app/assets/metronomes app/static/samples
RUN bash scripts/setup_assets.sh

# Set the PYTHONPATH to include the current directory
ENV PYTHONPATH=/app

# Make port 8000 available to the world outside this container
EXPOSE 8000

# Run the application using the module path
# -w 1: Maximize RAM available to the single worker (for 512MB environments)
# --timeout 300: Allow up to 5 minutes for long audio generation (7+ minute tracks)
CMD ["gunicorn", "-w", "1", "-k", "uvicorn.workers.UvicornWorker", "--timeout", "300", "--bind", "0.0.0.0:8000", "app.main:app"]
